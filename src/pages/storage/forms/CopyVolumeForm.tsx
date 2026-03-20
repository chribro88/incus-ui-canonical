import type { ChangeEvent, FC } from "react";
import { useEffect, useState } from "react";
import { useFormik } from "formik";
import {
  ActionButton,
  Button,
  Form,
  Input,
  Modal,
  Select,
  useToastNotification,
} from "@canonical/react-components";
import * as Yup from "yup";
import { useEventQueue } from "context/eventQueue";
import type { LxdStorageVolume } from "types/storage";
import StoragePoolSelector from "../StoragePoolSelector";
import { checkDuplicateName, getUniqueResourceName } from "util/helpers";
import { useProjects } from "context/useProjects";
import { useLoadCustomVolumes } from "context/useVolumes";
import ClusterMemberSelector from "pages/cluster/ClusterMemberSelector";
import { useStoragePool } from "context/useStoragePools";
import { isRemoteStorage } from "util/storageOptions";
import { copyStorageVolume } from "api/storage-volumes";
import VolumeLinkChip from "pages/storage/VolumeLinkChip";

interface Props {
  volume: LxdStorageVolume;
  close: () => void;
}

export interface StorageVolumeCopyFormValues {
  name: string;
  project: string;
  pool: string;
  copySnapshots: boolean;
  location: string;
}

export const getStorageVolumeCopyTarget = (
  driver: string,
  location: string,
): string => {
  return isRemoteStorage(driver) ? "" : location;
};

export const buildStorageVolumeCopyPayload = (
  volume: LxdStorageVolume,
  values: StorageVolumeCopyFormValues,
  driver: string,
): Partial<LxdStorageVolume> => {
  const source = {
    name: volume.name,
    type: "copy",
    pool: volume.pool,
    volume_only: !values.copySnapshots,
    // logic from the lxc source code.
    // We should not set source.project if target project is the same as the source project
    project: 
      values.project !== volume.project ? volume.project : undefined,
    ...(isRemoteStorage(driver) ? {} : { location: volume.location }),
  };

  return {
    name: values.name,
    type: "custom",
    config: volume.config,
    description: volume.description,
    content_type: volume.content_type,
    source,
  };
};

const CopyVolumeForm: FC<Props> = ({ volume, close }) => {
  const toastNotify = useToastNotification();
  const controllerState = useState<AbortController | null>(null);
  const [lastMemberLocalLocation, setLastMemberLocalLocation] = useState(
    volume.location,
  );
  const eventQueue = useEventQueue();

  const { data: projects = [], isLoading: projectsLoading } = useProjects();
  const { data: volumes = [], isLoading: volumesLoading } =
    useLoadCustomVolumes(volume.project);

  const notifySuccess = (values: StorageVolumeCopyFormValues) => {
    const newVolume = {
      ...volume,
      name: values.name,
      project: values.project,
      pool: values.pool,
      location: values.location,
    };
    toastNotify.success(
      <>
        Created volume <VolumeLinkChip volume={newVolume} />.
      </>,
    );
  };

  const notifyError = (error: Error) => {
    toastNotify.failure(
      "Volume copy failed.",
      error,
      <VolumeLinkChip volume={volume} />,
    );
  };

  const getCopiedVolumeName = (volume: LxdStorageVolume): string => {
    const newVolumeName = volume.name + "-copy";
    return getUniqueResourceName(newVolumeName, volumes);
  };

  // this validation checks given changes in any one of the fields (name, project, pool)
  // if the volume name already exists in the target project and storage pool
  const validationSchema = Yup.object()
    .shape({
      name: Yup.string().required("Volume name is required"),
      project: Yup.string().required(),
      pool: Yup.string().required(),
      location: Yup.string().optional(),
    })
    .test("deduplicate", "", async function (values) {
      const { name, project, pool, location } = values;
      const notFound = await checkDuplicateName(
        name,
        project || "default",
        controllerState,
        `storage-pools/${encodeURIComponent(pool)}/volumes/custom`,
        location,
      );

      if (notFound) {
        return true;
      }

      return this.createError({
        path: "name",
        message:
          "A volume with this name already exist in the target project and storage pool",
      });
    });

  const formik = useFormik<StorageVolumeCopyFormValues>({
    initialValues: {
      name: getCopiedVolumeName(volume),
      project: volume.project,
      copySnapshots: true,
      pool: volume.pool,
      location: volume.location,
    },
    enableReinitialize: true,
    validationSchema,
    onSubmit: (values, { setSubmitting }) => {
      if (!isDestinationPoolReady || !destinationPoolDriver) {
        toastNotify.failure(
          "Volume copy failed.",
          new Error("Destination storage pool details are still loading."),
        );
        setSubmitting(false);
        return;
      }

      const payload = buildStorageVolumeCopyPayload(
        volume,
        values,
        destinationPoolDriver,
      );
      const target = getStorageVolumeCopyTarget(
        destinationPoolDriver,
        values.location,
      );
      
      copyStorageVolume(payload, values.pool, values.project, target)
        .then((operation) => {
          toastNotify.info(
            <>
              Copy of volume <VolumeLinkChip volume={volume} /> started.
            </>,
          );
          eventQueue.set(
            operation.metadata.id,
            () => {
              notifySuccess(values);
            },
            (msg) => {
              notifyError(new Error(msg));
            },
          );
        })
        .catch((e) => {
          toastNotify.failure("Volume copy failed.", e);
        })
        .finally(() => {
          close();
        });
    },
  });

  const {
    data: destinationPool,
    isLoading: destinationPoolLoading,
    isFetching: destinationPoolFetching,
  } = useStoragePool(formik.values.pool);
  const { location } = formik.values;
  const { setFieldValue } = formik;
  const destinationPoolDriver = destinationPool?.driver;
  const isDestinationPoolReady =
    !!destinationPoolDriver && !destinationPoolLoading && !destinationPoolFetching;
  const showClusterMemberSelector =
    isDestinationPoolReady && !isRemoteStorage(destinationPoolDriver);

  useEffect(() => {
    setLastMemberLocalLocation(volume.location);
  }, [volume.location]);

  useEffect(() => {
    if (!destinationPoolDriver) {
      return;
    }

    if (isRemoteStorage(destinationPoolDriver) && location) {
      void setFieldValue("location", "");
    }

    if (
      !isRemoteStorage(destinationPoolDriver) &&
      !location &&
      lastMemberLocalLocation
    ) {
      void setFieldValue("location", lastMemberLocalLocation);
    }
  }, [
    destinationPoolDriver,
    lastMemberLocalLocation,
    location,
    setFieldValue,
  ]);

  const locationFieldProps = formik.getFieldProps("location");

  const handleLocationChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setLastMemberLocalLocation(event.currentTarget.value);
    locationFieldProps.onChange(event);
  };
  
  return (
    <Modal
      close={close}
      className="copy-volumes-modal"
      title="Copy volume"
      buttonRow={
        <>
          <Button
            appearance="base"
            className="u-no-margin--bottom"
            type="button"
            onClick={close}
          >
            Cancel
          </Button>
          <ActionButton
            appearance="positive"
            className="u-no-margin--bottom"
            loading={formik.isSubmitting}
            disabled={
              !formik.isValid ||
              formik.isSubmitting ||
              !isDestinationPoolReady ||
              projectsLoading ||
              volumesLoading
            }
            onClick={() => void formik.submitForm()}
          >
            Copy
          </ActionButton>
        </>
      }
    >
      <Form onSubmit={formik.handleSubmit}>
        <Input
          {...formik.getFieldProps("name")}
          type="text"
          label="New volume name"
          error={formik.touched.name ? formik.errors.name : null}
        />
        <StoragePoolSelector
          value={formik.values.pool}
          setValue={(value) => void formik.setFieldValue("pool", value)}
          selectProps={{
            id: "pool",
            label: "Storage pool",
          }}
        />
        {showClusterMemberSelector && (
          <ClusterMemberSelector
            {...locationFieldProps}
            onChange={handleLocationChange}
          />
        )}
        <Select
          {...formik.getFieldProps("project")}
          id="project"
          label="Target project"
          options={projects.map((project) => {
            return {
              label: project.name,
              value: project.name,
            };
          })}
        />
        <Input
          {...formik.getFieldProps("copySnapshots")}
          type="checkbox"
          label="Copy with snapshots"
          checked={formik.values.copySnapshots}
          error={
            formik.touched.copySnapshots ? formik.errors.copySnapshots : null
          }
        />
        {/* hidden submit to enable enter key in inputs */}
        <Input type="submit" hidden value="Hidden input" />
      </Form>
    </Modal>
  );
};

export default CopyVolumeForm;
