import React, { useEffect, useState } from "react";
import {
  Operation,
  OperationForget,
  OperationRestore,
  OperationStatus,
} from "../../../gen/ts/v1/operations_pb";
import { HeavyAccordion } from "../../components/common/HeavyAccordion";
import {
  Button,
  GridItem,
  Collapsible,
  Box,
  Flex,
  Text,
  Stack,
  SimpleGrid,
  Heading,
  Code,
  IconButton,
  Input,
  Badge,
  Group,
} from "@chakra-ui/react";
import {
  MenuRoot,
  MenuTrigger,
  MenuContent,
  MenuItem,
} from "../../components/ui/menu";
import {
  FiFileText,
  FiMoreVertical,
  FiTrash2,
  FiX,
  FiTag,
  FiPlus,
  FiGitCommit,
  FiPlay,
  FiRefreshCcw,
  FiExternalLink,
} from "react-icons/fi";
import { ProgressCircle } from "../../components/ui/progress-circle";
import { ProgressBar, ProgressRoot } from "../../components/ui/progress";
import { toaster } from "../../components/ui/toaster";

import {
  BackupProgressEntry,
  ResticSnapshot,
  SnapshotSummary,
} from "../../../gen/ts/v1/restic_pb";
import { SnapshotBrowser } from "../repositories/SnapshotBrowser";
import { SnapshotDiffModal } from "../repositories/SnapshotDiffModal";
import {
  formatBytes,
  formatDuration,
  formatTime,
  normalizeSnapshotId,
} from "../../lib/formatting";
import {
  ClearHistoryRequestSchema,
  UpdateSnapshotTagsRequestSchema,
  BackupRequestSchema,
} from "../../../gen/ts/v1/service_pb";
import { backrestService } from "../../api/client";
import { useConfig } from "../../app/provider";
import { useShowModal } from "../../components/common/ModalManager";
import {
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  DialogCloseTrigger,
} from "../../components/ui/dialog";
import { alerts } from "../../components/common/Alerts";
import {
  displayTypeToString,
  getTypeForDisplay,
  nameForStatus,
  colorForStatus,
} from "../../api/flowDisplayAggregator";
import { OperationIcon } from "./OperationIcon";
import { LogView } from "../../components/common/LogView";

import { create } from "@bufbuild/protobuf";
import { OperationListView } from "./OperationListView";
import * as m from "../../paraglide/messages";
import { FormModal } from "../../components/common/FormModal";

const ConfirmMenuItem = ({
  onConfirm,
  confirmText,
  children,
  ...props
}: {
  onConfirm: () => void;
  confirmText: React.ReactNode;
  children: React.ReactNode;
} & React.ComponentProps<typeof MenuItem>) => {
  const [needsConfirm, setNeedsConfirm] = useState(false);

  return (
    <MenuItem
      {...props}
      closeOnSelect={needsConfirm}
      onMouseLeave={() => setNeedsConfirm(false)}
      onClick={(e) => {
        if (!needsConfirm) {
          e.preventDefault();
          setNeedsConfirm(true);
        } else {
          onConfirm();
        }
      }}
    >
      {needsConfirm ? confirmText : children}
    </MenuItem>
  );
};

export const OperationRow = ({
  operation,
  showPlan,
  hookOperations,
  showDelete,
}: React.PropsWithoutRef<{
  operation: Operation;
  alertApi?: any; // Toaster doesn't need passing, but keeping for compatibility for now
  showPlan?: boolean;
  hookOperations?: Operation[];
  showDelete?: boolean;
}>) => {
  const showModal = useShowModal();
  const [config] = useConfig();
  const displayType = getTypeForDisplay(operation);
  const setRefresh = useState(0)[1];

  const handleBackupNow = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await backrestService.backup(
        create(BackupRequestSchema, { value: operation.planId }),
      );
      alerts.success(m.plan_backup_scheduled());
    } catch (e: any) {
      alerts.error(m.plan_error_backup() + e.message);
    }
  };

  const handleRestore = (e: React.MouseEvent) => {
    e.stopPropagation();
    const plan = config?.plans.find((p) => p.id === operation.planId);
    if (!plan) {
      alerts.error("Plan not found in configuration.");
      return;
    }
    const originalPath = plan.paths[0] || "";
    const volumeName = plan.id;

    import("../docker/DockerRestoreModal")
      .then(({ DockerRestoreModal }) => {
        showModal(
          <DockerRestoreModal
            planId={operation.planId}
            repoId={operation.repoId || plan.repo}
            volumeName={volumeName}
            originalPath={originalPath}
            onClose={() => showModal(null)}
          />,
        );
      })
      .catch((err) => {
        alerts.error("Failed to load restore modal: " + err.message);
      });
  };

  useEffect(() => {
    if (operation.status === OperationStatus.STATUS_INPROGRESS) {
      const interval = setInterval(() => {
        setRefresh((x) => x + 1);
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [operation.status]);

  const doDelete = async () => {
    try {
      await backrestService.clearHistory(
        create(ClearHistoryRequestSchema, {
          selector: {
            ids: [operation.id!],
          },
          onlyFailed: false,
        }),
      );
      alerts.success(m.op_row_deleted_success());
    } catch (e: any) {
      alerts.error(m.op_row_deleted_error() + e.message);
    }
  };

  const doCancel = async () => {
    try {
      await backrestService.cancel({ value: operation.id! });
      alerts.success(m.op_row_cancel_success());
    } catch (e: any) {
      alerts.error(m.op_row_cancel_error() + e.message);
    }
  };

  const doShowLogs = () => {
    showModal(
      <FormModal
        size="large"
        title={m.op_row_logs_title({
          name: opName,
          time: formatTime(Number(operation.unixTimeStartMs)),
        })}
        isOpen={true}
        onClose={() => {
          showModal(null);
        }}
        footer={null}
      >
        <LogView logref={operation.logref!} />
      </FormModal>,
    );
  };

  let details: string = "";
  if (operation.status !== OperationStatus.STATUS_SUCCESS) {
    details = nameForStatus(operation.status);
  }
  if (operation.unixTimeEndMs - operation.unixTimeStartMs > 100) {
    details +=
      " in " +
      formatDuration(
        Number(operation.unixTimeEndMs - operation.unixTimeStartMs),
      );
  }

  const opName = displayTypeToString(getTypeForDisplay(operation));

  const title: React.ReactNode[] = [
    <div key="title">
      {showPlan
        ? operation.instanceId + " - " + operation.planId + " - "
        : undefined}{" "}
      {formatTime(Number(operation.unixTimeStartMs))} - {opName}{" "}
      <span className="backrest operation-details">{details}</span>
    </div>,
  ];

  // --- Menu Items Logic ---
  const menuItems: React.ReactNode[] = [];

  if (operation.logref) {
    menuItems.push(
      <MenuItem key="logs" value="logs" onClick={doShowLogs}>
        <FiFileText /> {m.op_row_view_logs()}
      </MenuItem>,
    );
  }

  if (
    operation.status === OperationStatus.STATUS_INPROGRESS ||
    operation.status === OperationStatus.STATUS_PENDING
  ) {
    menuItems.push(
      <ConfirmMenuItem
        key="cancel"
        value="cancel"
        onConfirm={doCancel}
        confirmText={m.op_row_confirm_cancel()}
        color="fg.error"
      >
        {m.op_row_cancel_op()}
      </ConfirmMenuItem>,
    );
  } else if (showDelete) {
    menuItems.push(
      <ConfirmMenuItem
        key="delete"
        value="delete"
        onConfirm={doDelete}
        confirmText={m.op_row_confirm_delete()}
        color="fg.error"
      >
        <FiTrash2 /> {m.op_row_delete()}
      </ConfirmMenuItem>,
    );
  }

  let displayMessage = operation.displayMessage;

  const bodyItems: { key: string; label: string; children: React.ReactNode }[] =
    [];
  const expandedBodyItems: string[] = [];

  if (operation.op.case === "operationBackup") {
    if (
      operation.status === OperationStatus.STATUS_INPROGRESS ||
      operation.status === OperationStatus.STATUS_PENDING
    ) {
      expandedBodyItems.push("details");
    }
    const backupOp = operation.op.value;
    bodyItems.push({
      key: "details",
      label: m.op_row_backup_details(),
      children: (
        <BackupOperationStatus
          operation={operation}
          status={backupOp.lastStatus}
          dryRun={backupOp.dryRun}
          operationStatus={operation.status}
        />
      ),
    });

    if (backupOp.errors.length > 0) {
      bodyItems.push({
        key: "errors",
        label: m.op_row_item_errors(),
        children: (
          <Table.Root size="sm" variant="outline">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeader>
                  {m.op_row_error_message()}
                </Table.ColumnHeader>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {backupOp.errors.map((e, idx) => (
                <Table.Row key={idx}>
                  <Table.Cell verticalAlign="top">
                    {e.message || e.item}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        ),
      });
    }
  } else if (operation.op.case === "operationIndexSnapshot") {
    expandedBodyItems.push("details");
    const snapshotOp = operation.op.value;
    bodyItems.push({
      key: "details",
      label: m.op_row_details(),
      children: (
        <SnapshotDetails
          snapshot={snapshotOp.snapshot!}
          repoId={operation.repoId}
          repoGuid={operation.repoGuid}
          planId={operation.planId}
          snapshotOpId={operation.id}
        />
      ),
    });
    bodyItems.push({
      key: "browser",
      label: m.op_row_snapshot_browser(),

      children: (
        <SnapshotBrowser
          snapshotId={snapshotOp.snapshot!.id}
          snapshotOpId={operation.id}
          repoId={operation.repoId}
          repoGuid={operation.repoGuid}
          planId={operation.planId}
        />
      ),
    });
  } else if (operation.op.case === "operationForget") {
    const forgetOp = operation.op.value;
    expandedBodyItems.push("forgot");
    bodyItems.push({
      key: "forgot",
      label: m.op_row_removed_snapshots({
        count: forgetOp.forget?.length || 0,
      }),
      children: <ForgetOperationDetails forgetOp={forgetOp} />,
    });
  } else if (operation.op.case === "operationPrune") {
    const prune = operation.op.value;
    expandedBodyItems.push("prune");
    bodyItems.push({
      key: "prune",
      label: m.op_row_prune_output(),
      children: prune.outputLogref ? (
        <LogView logref={prune.outputLogref} />
      ) : (
        <pre>{prune.output}</pre>
      ),
    });
  } else if (operation.op.case === "operationCheck") {
    const check = operation.op.value;
    expandedBodyItems.push("check");
    bodyItems.push({
      key: "check",
      label: m.op_row_check_output(),
      children: check.outputLogref ? (
        <LogView logref={check.outputLogref} />
      ) : (
        <pre>{check.output}</pre>
      ),
    });
  } else if (operation.op.case === "operationRunCommand") {
    const run = operation.op.value;
    if (run.outputSizeBytes < 64 * 1024) {
      expandedBodyItems.push("run");
    }
    bodyItems.push({
      key: "run",
      label:
        m.op_row_command_output() +
        (run.outputSizeBytes > 0
          ? ` (${formatBytes(Number(run.outputSizeBytes))})`
          : ""),
      children: (
        <>
          <LogView logref={run.outputLogref} />
        </>
      ),
    });
  } else if (operation.op.case === "operationRestore") {
    expandedBodyItems.push("restore");
    bodyItems.push({
      key: "restore",
      label: m.op_row_restore_details(),
      children: <RestoreOperationStatus operation={operation} />,
    });
  } else if (operation.op.case === "operationRunHook") {
    const hook = operation.op.value;
    if (operation.logref) {
      if (operation.status === OperationStatus.STATUS_INPROGRESS) {
        expandedBodyItems.push("logref");
      }
      bodyItems.push({
        key: "logref",
        label: m.op_row_hook_output(),
        children: <LogView logref={operation.logref} />,
      });
    }
  }

  if (hookOperations) {
    bodyItems.push({
      key: "hookOperations",
      label: m.op_row_hooks_triggered(),
      children: (
        <OperationListView
          useOperations={hookOperations}
          displayHooksInline={true}
        />
      ),
    });

    for (const op of hookOperations) {
      if (op.status !== OperationStatus.STATUS_SUCCESS) {
        expandedBodyItems.push("hookOperations");
        break;
      }
    }
  }

  return (
    <Box
      className="backrest visible-on-hover"
      mb={2}
      borderWidth="1px"
      borderRadius="md"
      bg="bg.panel"
      _hover={{ borderColor: "border.emphasized" }}
    >
      <Box p={3}>
        <Flex align="center" gap={3}>
          <OperationIcon type={displayType} status={operation.status} />
          <Box flex={1}>
            <Flex wrap="wrap" align="baseline" gap={2}>
              {title}
            </Flex>
          </Box>
          {operation.planId &&
            (operation.op.case === "operationBackup" ||
              operation.op.case === "operationIndexSnapshot") && (
            <Group attached>
              <Button
                size="xs"
                variant="outline"
                colorPalette="blue"
                onClick={handleBackupNow}
              >
                <FiPlay /> {m.plan_button_backup()}
              </Button>
              <Button
                size="xs"
                variant="outline"
                colorPalette="green"
                onClick={handleRestore}
              >
                <FiRefreshCcw /> {m.op_type_restore()}
              </Button>
            </Group>
          )}
          {menuItems.length > 0 && (
            <MenuRoot>
              <MenuTrigger asChild>
                <IconButton variant="ghost" size="sm" aria-label="Actions">
                  <FiMoreVertical />
                </IconButton>
              </MenuTrigger>
              <MenuContent>{menuItems}</MenuContent>
            </MenuRoot>
          )}
        </Flex>

        {operation.displayMessage && (
          <Box mt={2}>
            <Box
              pl={3}
              borderLeftWidth="4px"
              borderLeftColor={colorForStatus(operation.status)}
              py={1}
            >
              <Text fontSize="xs" whiteSpace="pre-wrap">
                {operation.status !== OperationStatus.STATUS_SUCCESS && (
                  <Text as="span" fontWeight="bold">
                    {nameForStatus(operation.status)}:{" "}
                  </Text>
                )}
                {operation.displayMessage}
              </Text>
            </Box>
          </Box>
        )}

        {bodyItems.length > 0 && (
          <Box mt={2} pl={2}>
            <HeavyAccordion
              items={bodyItems}
              defaultExpanded={expandedBodyItems}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
};

const ClickableSnapshotId = ({
  snapshotId,
  repoId,
  repoGuid,
  planId,
  snapshotOpId,
}: {
  snapshotId: string;
  repoId?: string;
  repoGuid?: string;
  planId?: string;
  snapshotOpId?: bigint;
}) => {
  const showModal = useShowModal();
  const [config] = useConfig();

  const resolvedRepoId = React.useMemo(() => {
    if (repoId) return repoId;
    if (planId) {
      const plan = config?.plans.find((p) => p.id === planId);
      if (plan) return plan.repo || "";
    }
    return "";
  }, [repoId, planId, config]);

  const resolvedRepoGuid = React.useMemo(() => {
    if (repoGuid) return repoGuid;
    const rId = resolvedRepoId;
    if (rId) {
      const repo = config?.repos.find((r) => r.id === rId);
      if (repo) return repo.guid;
    }
    return "";
  }, [repoGuid, resolvedRepoId, config]);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    showModal(
      <DialogRoot open={true} onOpenChange={(e) => !e.open && showModal(null)} size="lg">
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Browse Snapshot {normalizeSnapshotId(snapshotId)}</DialogTitle>
          </DialogHeader>
          <DialogBody maxH="70vh" overflowY="auto">
            <SnapshotBrowser
              snapshotId={snapshotId}
              snapshotOpId={snapshotOpId}
              repoId={resolvedRepoId}
              repoGuid={resolvedRepoGuid}
              planId={planId}
            />
          </DialogBody>
          <DialogFooter>
            <DialogCloseTrigger asChild>
              <Button variant="outline" onClick={() => showModal(null)}>
                {m.button_close()}
              </Button>
            </DialogCloseTrigger>
          </DialogFooter>
        </DialogContent>
      </DialogRoot>
    );
  };

  return (
    <Code
      fontSize="3xs"
      variant="subtle"
      p={1}
      cursor="pointer"
      _hover={{ bg: "bg.emphasized", color: "colorPalette.fg" }}
      onClick={handleClick}
      display="inline-flex"
      alignItems="center"
      gap={1}
    >
      {normalizeSnapshotId(snapshotId)}
      <FiExternalLink size={10} />
    </Code>
  );
};

const SnapshotDetails = ({
  snapshot,
  repoId,
  repoGuid,
  planId,
  snapshotOpId,
}: {
  snapshot: ResticSnapshot;
  repoId: string;
  repoGuid?: string;
  planId?: string;
  snapshotOpId?: bigint;
}) => {
  const showModal = useShowModal();
  const [tags, setTags] = useState(snapshot.tags);
  const [newTag, setNewTag] = useState("");
  const [isUpdating, setIsUpdating] = useState(false);

  const handleAddTag = async () => {
    if (!newTag) return;
    setIsUpdating(true);
    try {
      await backrestService.updateSnapshotTags(
        create(UpdateSnapshotTagsRequestSchema, {
          repoId,
          snapshotIds: [snapshot.id!],
          addTags: [newTag],
        }),
      );
      setTags([...tags, newTag]);
      setNewTag("");
      alerts.success("Tag added successfully.");
    } catch (e: any) {
      alerts.error("Failed to add tag: " + e.message);
    } finally {
      setIsUpdating(false);
    }
  };

  const handleRemoveTag = async (tag: string) => {
    setIsUpdating(true);
    try {
      await backrestService.updateSnapshotTags(
        create(UpdateSnapshotTagsRequestSchema, {
          repoId,
          snapshotIds: [snapshot.id!],
          removeTags: [tag],
        }),
      );
      setTags(tags.filter((t) => t !== tag));
      alerts.success("Tag removed successfully.");
    } catch (e: any) {
      alerts.error("Failed to remove tag: " + e.message);
    } finally {
      setIsUpdating(false);
    }
  };

  const summary = snapshot.summary;

  const showDiff = () => {
    showModal(
      <SnapshotDiffModal
        repoId={repoId}
        baseSnapshotId={snapshot.id!}
        onClose={() => showModal(null)}
      />,
    );
  };

  return (
    <>
      <Flex justify="space-between" align="center">
        <Flex align="center" gap={2}>
          <Text fontWeight="bold">
            {m.op_row_snapshot_id()}
          </Text>
          {repoGuid ? (
            <ClickableSnapshotId
              snapshotId={snapshot.id!}
              repoId={repoId}
              repoGuid={repoGuid}
              planId={planId}
              snapshotOpId={snapshotOpId}
            />
          ) : (
            normalizeSnapshotId(snapshot.id!)
          )}
        </Flex>
        <Button size="xs" variant="outline" onClick={showDiff}>
          <FiGitCommit /> {m.snapshot_diff_compare()}
        </Button>
      </Flex>

      <Box mt={4}>
        <Text fontWeight="bold" mb={2}>
          {m.snapshot_tags_label()}
        </Text>
        <Flex wrap="wrap" gap={2} mb={2}>
          {tags.map((tag) => (
            <Badge key={tag} colorPalette="blue" variant="subtle" px={2} py={1}>
              {tag}
              <IconButton
                variant="ghost"
                size="xs"
                ml={1}
                disabled={isUpdating}
                onClick={() => handleRemoveTag(tag)}
                aria-label="Remove tag"
              >
                <FiX size={10} />
              </IconButton>
            </Badge>
          ))}
        </Flex>
        <Group attached width="full" maxW="300px">
          <Input
            placeholder={m.snapshot_tag_add()}
            size="xs"
            value={newTag}
            onChange={(e) => setNewTag(e.target.value)}
            disabled={isUpdating}
            onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
          />
          <IconButton
            size="xs"
            colorPalette="blue"
            onClick={handleAddTag}
            loading={isUpdating}
          >
            <FiPlus />
          </IconButton>
        </Group>
      </Box>

      <SimpleGrid columns={3} gap={4} mt={4}>
        <GridItem colSpan={1}>
          <Text fontWeight="bold">{m.op_row_user_host()}</Text>
          <Text color="fg.muted">
            {snapshot.username}@{snapshot.hostname}
          </Text>
        </GridItem>
        <GridItem colSpan={2}>
          <Text fontWeight="bold">{m.op_row_tags()}</Text>
          <Text color="fg.muted">{snapshot.tags.join(", ")}</Text>
        </GridItem>
      </SimpleGrid>

      {summary && (
        <>
          <SimpleGrid columns={3} gap={4} mt={2}>
            <Box>
              <Text fontWeight="bold">{m.op_row_files_added()}</Text>
              <Text color="fg.muted">{summary.filesNew.toLocaleString()}</Text>
            </Box>
            <Box>
              <Text fontWeight="bold">{m.op_row_files_changed()}</Text>
              <Text color="fg.muted">
                {summary.filesChanged.toLocaleString()}
              </Text>
            </Box>
            <Box>
              <Text fontWeight="bold">{m.op_row_files_unmodified()}</Text>
              <Text color="fg.muted">
                {summary.filesUnmodified.toLocaleString()}
              </Text>
            </Box>
          </SimpleGrid>
          <SimpleGrid columns={3} gap={4}>
            <Box>
              <Text fontWeight="bold">{m.op_row_bytes_added()}</Text>
              <Text color="fg.muted">
                {formatBytes(Number(summary.dataAdded))}
              </Text>
            </Box>
            <Box>
              <Text fontWeight="bold">{m.op_row_total_bytes()}</Text>
              <Text color="fg.muted">
                {formatBytes(Number(summary.totalBytesProcessed))}
              </Text>
            </Box>
            <Box>
              <Text fontWeight="bold">{m.op_row_total_files()}</Text>
              <Text color="fg.muted">
                {summary.totalFilesProcessed.toLocaleString()}
              </Text>
            </Box>
          </SimpleGrid>
        </>
      )}
    </>
  );
};

const RestoreOperationStatus = ({ operation }: { operation: Operation }) => {
  const restoreOp = operation.op.value as OperationRestore;
  const isDone = restoreOp.lastStatus?.messageType === "summary";
  const progress = restoreOp.lastStatus?.percentDone || 0;
  const lastStatus = restoreOp.lastStatus;

  return (
    <>
      <Stack gap={4} mb={4}>
        <Box>
          <Text fontWeight="bold" fontSize="xs" color="fg.muted" mb={1}>
            {m.op_row_restore_source()}
          </Text>
          <Code
            p={2}
            borderRadius="md"
            width="full"
            display="block"
            whiteSpace="pre-wrap"
          >
            {restoreOp.path}
          </Code>
        </Box>
        <Box>
          <Text fontWeight="bold" fontSize="xs" color="fg.muted" mb={1}>
            {m.op_row_restore_target()}
          </Text>
          <Code
            p={2}
            borderRadius="md"
            width="full"
            display="block"
            whiteSpace="pre-wrap"
          >
            {restoreOp.target}
          </Code>
        </Box>
      </Stack>

      {!isDone ? (
        <ProgressRoot value={progress * 100} max={100} size="sm" mb={4}>
          <ProgressBar />
        </ProgressRoot>
      ) : null}

      {operation.status == OperationStatus.STATUS_SUCCESS ? (
        <Box mb={4}>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              backrestService
                .getDownloadURL({ opId: operation.id!, filePath: "" })
                .then((resp) => {
                  window.open(resp.value, "_blank");
                })
                .catch((e) => {
                  alerts.error(m.op_row_fetch_download_error() + e.message);
                });
            }}
          >
            {m.op_row_download_files()}
          </Button>
        </Box>
      ) : null}

      <SimpleGrid columns={2} gap={4}>
        <Box>
          <Text fontWeight="bold">{m.op_row_snapshot_id()}</Text>
          <Box mt={1}>
            <ClickableSnapshotId
              snapshotId={operation.snapshotId!}
              repoId={operation.repoId}
              repoGuid={operation.repoGuid}
              planId={operation.planId}
              snapshotOpId={operation.id}
            />
          </Box>
        </Box>
        {lastStatus && (
          <>
            <Box>
              <Text fontWeight="bold">{m.op_row_bytes_done_total()}</Text>
              <Text color="fg.muted">
                {formatBytes(Number(lastStatus.bytesRestored))}/
                {formatBytes(Number(lastStatus.totalBytes))}
              </Text>
            </Box>
            <Box>
              <Text fontWeight="bold">{m.op_row_files_done_total()}</Text>
              <Text color="fg.muted">
                {Number(lastStatus.filesRestored)}/
                {Number(lastStatus.totalFiles)}
              </Text>
            </Box>
          </>
        )}
      </SimpleGrid>
    </>
  );
};

import { Spinner } from "@chakra-ui/react";

const BackupOperationStatus = ({
  operation,
  status,
  dryRun,
  operationStatus,
}: {
  operation?: Operation;
  status?: BackupProgressEntry;
  dryRun?: boolean;
  operationStatus?: OperationStatus;
}) => {
  if (!status) {
    if (operationStatus === OperationStatus.STATUS_PENDING) {
      return (
        <Flex align="center" gap={2} py={2}>
          <Spinner size="xs" color="blue.500" />
          <Text fontSize="xs" color="fg.muted" fontStyle="italic">
            Backup is queued and pending execution...
          </Text>
        </Flex>
      );
    }
    return <>{m.op_row_no_status()}</>;
  }

  if (status.entry.case === "status") {
    const st = status.entry.value;
    const progress =
      Math.round(
        (Number(st.bytesDone) / Math.max(Number(st.totalBytes), 1)) * 1000,
      ) / 10;
    return (
      <>
        <ProgressRoot value={progress} max={100} size="sm" mb={4}>
          <ProgressBar />
        </ProgressRoot>
        <SimpleGrid columns={2} gap={4}>
          <Box>
            <Text fontWeight="bold">{m.op_row_bytes_done_total()}</Text>
            <Text color="fg.muted">
              {formatBytes(Number(st.bytesDone))} /{" "}
              {formatBytes(Number(st.totalBytes))}
            </Text>
          </Box>
          <Box>
            <Text fontWeight="bold">{m.op_row_files_done_total()}</Text>
            <Text color="fg.muted">
              {Number(st.filesDone).toLocaleString()} /{" "}
              {Number(st.totalFiles).toLocaleString()}
            </Text>
          </Box>
        </SimpleGrid>
        {st.currentFile && st.currentFile.length > 0 && (
          <Box mt={2}>
            <Text fontWeight="bold">{m.op_row_current_files()}</Text>
            <Code
              display="block"
              mt={1}
              p={2}
              borderRadius="md"
              fontSize="xs"
              whiteSpace="pre"
            >
              {st.currentFile.join("\n")}
            </Code>
          </Box>
        )}
      </>
    );
  } else if (status.entry.case === "summary") {
    const sum = status.entry.value;
    return (
      <>
        <Flex align="center" gap={2}>
          <Text fontWeight="bold">
            {m.op_row_snapshot_id()}
          </Text>
          {sum.snapshotId !== "" && !dryRun ? (
            operation ? (
              <ClickableSnapshotId
                snapshotId={sum.snapshotId!}
                repoId={operation.repoId}
                repoGuid={operation.repoGuid}
                planId={operation.planId}
                snapshotOpId={operation.id}
              />
            ) : (
              normalizeSnapshotId(sum.snapshotId!)
            )
          ) : (
            m.op_row_no_snapshot()
          )}
        </Flex>
        <SimpleGrid columns={{ base: 1, md: 3 }} gap={4} mt={2}>
          <Box>
            <Text fontWeight="bold">{m.op_row_files_added()}</Text>
            <Text color="fg.muted">
              {Number(sum.filesNew).toLocaleString()}
            </Text>
          </Box>
          <Box>
            <Text fontWeight="bold">{m.op_row_files_changed()}</Text>
            <Text color="fg.muted">
              {Number(sum.filesChanged).toLocaleString()}
            </Text>
          </Box>
          <Box>
            <Text fontWeight="bold">{m.op_row_files_unmodified()}</Text>
            <Text color="fg.muted">
              {Number(sum.filesUnmodified).toLocaleString()}
            </Text>
          </Box>
        </SimpleGrid>
        <SimpleGrid columns={{ base: 1, md: 3 }} gap={4} mt={2}>
          <Box>
            <Text fontWeight="bold">{m.op_row_bytes_added()}</Text>
            <Text color="fg.muted">{formatBytes(Number(sum.dataAdded))}</Text>
          </Box>
          <Box>
            <Text fontWeight="bold">{m.op_row_total_bytes()}</Text>
            <Text color="fg.muted">
              {formatBytes(Number(sum.totalBytesProcessed))}
            </Text>
          </Box>
          <Box>
            <Text fontWeight="bold">{m.op_row_total_files()}</Text>
            <Text color="fg.muted">
              {Number(sum.totalFilesProcessed).toLocaleString()}
            </Text>
          </Box>
        </SimpleGrid>
      </>
    );
  } else {
    console.error("GOT UNEXPECTED STATUS: ", status);
    return <>{m.op_row_unexpected_status() + JSON.stringify(status)}</>;
  }
};

import {
  Table,
  TableBody,
  TableCell,
  TableColumnHeader,
  TableHeader,
  TableRow,
} from "@chakra-ui/react";

const ForgetOperationDetails = ({
  forgetOp,
}: {
  forgetOp: OperationForget;
}) => {
  const removedSnapshots = forgetOp.forget || [];

  if (removedSnapshots.length === 0) {
    return (
      <Text color="fg.muted" fontStyle="italic">
        {m.op_row_removed_none()}
      </Text>
    );
  }

  return (
    <>
      <Table.Root size="sm" variant="outline">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader>{m.op_row_removed_id_col()}</Table.ColumnHeader>
            <Table.ColumnHeader>
              {m.op_row_removed_time_col()}
            </Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {removedSnapshots.map((f) => (
            <Table.Row key={f.id}>
              <Table.Cell fontFamily="mono">
                {normalizeSnapshotId(f.id!)}
              </Table.Cell>
              <Table.Cell>{formatTime(Number(f.unixTimeMs))}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </>
  );
};
