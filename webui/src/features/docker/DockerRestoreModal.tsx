import React, { useEffect, useState } from "react";
import {
  Button,
  Stack,
  Text,
  Box,
  Flex,
  Table,
  Badge,
  Spinner,
  Center,
  Heading,
  Separator,
} from "@chakra-ui/react";
import { backrestService } from "../../api/client";
import {
  ListSnapshotsRequestSchema,
  RestoreSnapshotRequestSchema,
} from "../../../gen/ts/v1/service_pb";
import { ResticSnapshot } from "../../../gen/ts/v1/restic_pb";
import { create } from "@bufbuild/protobuf";
import { alerts } from "../../components/common/Alerts";
import * as m from "../../paraglide/messages";
import {
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  DialogCloseTrigger,
} from "../../components/ui/dialog";
import { FiClock, FiRefreshCcw, FiAlertTriangle } from "react-icons/fi";
import { Checkbox } from "../../components/ui/checkbox";
import { Tooltip } from "../../components/ui/tooltip";
import { Input } from "@chakra-ui/react";
import { Field } from "../../components/ui/field";
import { Alert } from "../../components/ui/alert";

interface DockerRestoreModalProps {
  planId: string;
  repoId: string;
  volumeName: string;
  originalPath: string;
  onClose: () => void;
}

export const DockerRestoreModal = ({
  planId,
  repoId,
  volumeName,
  originalPath,
  onClose,
}: DockerRestoreModalProps) => {
  const [snapshots, setSnapshots] = useState<ResticSnapshot[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string>("");
  const [isRestoring, setIsRestoring] = useState(false);
  const [targetPath, setTargetPath] = useState(originalPath);
  const [useOriginalLocation, setUseOriginalLocation] = useState(true);
  const [stopContainer, setStopContainer] = useState(true);

  useEffect(() => {
    fetchSnapshots();
  }, [planId, repoId]);

  const fetchSnapshots = async () => {
    setIsLoading(true);
    try {
      const resp = await backrestService.listSnapshots(
        create(ListSnapshotsRequestSchema, {
          repoId,
          planId,
        })
      );
      // Sort snapshots by time descending
      const sorted = [...resp.snapshots].sort((a, b) => 
        Number(b.unixTimeMs || 0n) - Number(a.unixTimeMs || 0n)
      );
      setSnapshots(sorted);
      if (sorted.length > 0) {
        setSelectedSnapshotId(sorted[0].id);
      }
    } catch (e: any) {
      alerts.error(m.dashboard_error_fetch() + e.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRestore = async () => {
    if (!selectedSnapshotId) return;

    setIsRestoring(true);
    try {
      await backrestService.restore(
        create(RestoreSnapshotRequestSchema, {
          repoId,
          planId,
          snapshotId: selectedSnapshotId,
          target: useOriginalLocation ? originalPath : targetPath,
          path: "/",
          overwrite: true, // Always true here as the user is using the specialized Docker restore modal
          stopContainer: stopContainer,
        })
      );
      alerts.success("Restore operation started.");
      onClose();
    } catch (e: any) {
      alerts.error("Restore failed: " + e.message);
    } finally {
      setIsRestoring(false);
    }
  };

  const formatDate = (unixTimeMs: bigint) => {
    return new Date(Number(unixTimeMs)).toLocaleString();
  };

  return (
    <DialogRoot open={true} onOpenChange={(e) => !e.open && onClose()} size="lg">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {m.docker_restore_modal_title({ name: volumeName || originalPath })}
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Stack gap={6}>
            <Box>
              <Heading size="xs" mb={3}>
                <Flex align="center" gap={2}>
                  <FiClock /> {m.docker_restore_modal_select_snapshot()}
                </Flex>
              </Heading>
              {isLoading ? (
                <Center p={8}>
                  <Spinner />
                </Center>
              ) : snapshots.length === 0 ? (
                <Text color="fg.muted" textAlign="center" p={4}>
                  {m.docker_restore_modal_no_snapshots()}
                </Text>
              ) : (
                <Box
                  maxH="300px"
                  overflowY="auto"
                  borderWidth="1px"
                  borderRadius="md"
                >
                  <Table.Root size="sm" variant="outline" stickyHeader>
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeader width="40px"></Table.ColumnHeader>
                        <Table.ColumnHeader>Time</Table.ColumnHeader>
                        <Table.ColumnHeader>Snapshot ID</Table.ColumnHeader>
                        <Table.ColumnHeader>Tags</Table.ColumnHeader>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {snapshots.map((s) => (
                        <Table.Row
                          key={s.id}
                          cursor="pointer"
                          onClick={() => setSelectedSnapshotId(s.id)}
                          bg={selectedSnapshotId === s.id ? "blue.50" : undefined}
                          _dark={{ bg: selectedSnapshotId === s.id ? "blue.950" : undefined }}
                        >
                          <Table.Cell>
                            <Checkbox
                              checked={selectedSnapshotId === s.id}
                              onCheckedChange={() => setSelectedSnapshotId(s.id)}
                            />
                          </Table.Cell>
                          <Table.Cell>
                            {formatDate(s.unixTimeMs)}
                          </Table.Cell>
                          <Table.Cell>
                            <Text fontFamily="mono" fontSize="xs">
                              {s.id.substring(0, 8)}
                            </Text>
                          </Table.Cell>
                          <Table.Cell>
                            <Flex gap={1} flexWrap="wrap">
                              {(s.tags || []).map((t: string) => (
                                <Badge key={t} variant="subtle" size="xs">
                                  {t}
                                </Badge>
                              ))}
                            </Flex>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Root>
                </Box>
              )}
            </Box>

            <Separator />

            <Stack gap={4}>
              <Heading size="xs">
                <Flex align="center" gap={2}>
                  <FiRefreshCcw /> {m.op_type_restore()} Options
                </Flex>
              </Heading>

              <Checkbox
                checked={useOriginalLocation}
                onCheckedChange={(e) => setUseOriginalLocation(!!e.checked)}
              >
                {m.restore_modal_original_location()}
              </Checkbox>

              <Checkbox
                checked={stopContainer}
                onCheckedChange={(e) => setStopContainer(!!e.checked)}
              >
                <Tooltip content="Backrest will automatically identify and stop all containers mounting this volume to ensure data consistency. They will be restarted after restore completes.">
                  <Text as="span">Stop associated container(s) during restore</Text>
                </Tooltip>
              </Checkbox>

              {useOriginalLocation && (
                <Alert status="warning" variant="subtle" size="sm" icon={<FiAlertTriangle />}>
                  {m.restore_modal_original_location_warning()}
                </Alert>
              )}

              {!useOriginalLocation && (
                <Field label="Target Path">
                  <Input
                    placeholder="/home/user/restore-data"
                    value={targetPath}
                    onChange={(e) => setTargetPath(e.target.value)}
                  />
                </Field>
              )}
            </Stack>
          </Stack>
        </DialogBody>
        <DialogFooter>
          <DialogCloseTrigger asChild>
            <Button variant="outline" onClick={onClose}>
              {m.button_cancel()}
            </Button>
          </DialogCloseTrigger>
          <Button
            colorPalette="green"
            onClick={handleRestore}
            loading={isRestoring}
            disabled={!selectedSnapshotId}
          >
            <FiRefreshCcw /> {m.op_type_restore()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
};
