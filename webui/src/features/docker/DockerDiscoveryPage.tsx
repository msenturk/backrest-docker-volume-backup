import React, { useEffect, useState, useMemo } from "react";
import {
  Box,
  Button,
  Card,
  Flex,
  Heading,
  Stack,
  Text,
  Spinner,
  Center,
  SimpleGrid,
  Badge,
  IconButton,
  Collapsible,
  Input,
  Separator,
  Code,
  Group,
} from "@chakra-ui/react";
import {
  FiBox,
  FiChevronDown,
  FiChevronUp,
  FiDatabase,
  FiPlus,
  FiCheck,
  FiAlertTriangle,
  FiSearch,
  FiClipboard,
  FiInfo,
  FiPlay,
  FiRefreshCcw,
  FiExternalLink,
  FiClock,
  FiRadio,
} from "react-icons/fi";
import { backrestService } from "../../api/client";
import { useConfig } from "../../app/provider";
import {
  DockerContainer,
  CreateDockerPlansRequest,
  DockerPlanDefinitionSchema,
  BackupRequestSchema,
  GetOperationsRequestSchema,
  OpSelectorSchema,
} from "../../../gen/ts/v1/service_pb";
import { PlanSchema } from "../../../gen/ts/v1/config_pb";
import { Operation, OperationStatus } from "../../../gen/ts/v1/operations_pb";
import { create } from "@bufbuild/protobuf";
import { alerts, formatErrorAlert } from "../../components/common/Alerts";
import * as m from "../../paraglide/messages";
import { EmptyState } from "../../components/ui/empty-state";
import {
  SelectRoot,
  SelectTrigger,
  SelectValueText,
  SelectContent,
  SelectItem,
} from "../../components/ui/select";
import { createListCollection } from "@chakra-ui/react";
import { Checkbox } from "../../components/ui/checkbox";
import { Tooltip } from "../../components/ui/tooltip";
import {
  DialogRoot,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  DialogTrigger,
  DialogCloseTrigger,
} from "../../components/ui/dialog";
import { InputGroup } from "../../components/ui/input-group";
import { Switch } from "../../components/ui/switch";
import { useShowModal } from "../../components/common/ModalManager";
import { DockerRestoreModal } from "./DockerRestoreModal";
import { OperationRow } from "../operations/OperationRow";
import { useResourceStatus } from "../../api/resourceStatus";
import { colorForStatus, nameForStatus, displayTypeToString, getTypeForDisplay } from "../../api/flowDisplayAggregator";
import { normalizeSnapshotId } from "../../lib/formatting";
import { AddPlanModal } from "../plans/AddPlanModal";

export const DockerDiscoveryPage = () => {
  const [config, setConfig] = useConfig();
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [isRemote, setIsRemote] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedVolumes, setSelectedVolumes] = useState<Record<string, boolean>>({});
  const [selectedRepo, setSelectedRepo] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [groupByProject, setGroupByProject] = useState(true);
  const [planOperations, setPlanOperations] = useState<Record<string, Operation>>({});
  const showModal = useShowModal();

  useEffect(() => {
    fetchDockerResources();
  }, []);

  useEffect(() => {
    if (config?.repos.length && !selectedRepo) {
      setSelectedRepo(config.repos[0].id);
    }
  }, [config]);

  // Initial fetch of operations
  useEffect(() => {
    const fetchOps = async () => {
      if (!config?.plans.length) return;
      
      try {
        const operations: Record<string, Operation> = {};
        await Promise.all(config.plans.map(async (plan) => {
          const resp = await backrestService.getOperations(create(GetOperationsRequestSchema, {
            selector: {
              planId: plan.id,
            },
            lastN: 5n,
          }));
          // Find the last operation that resulted in a snapshot or was a successful backup
          const lastSuccess = resp.operations.find(op => 
            op.status === OperationStatus.STATUS_SUCCESS && 
            (op.op.case === "operationIndexSnapshot" || op.op.case === "operationBackup")
          );
          if (lastSuccess) {
            operations[plan.id] = lastSuccess;
          } else if (resp.operations.length > 0) {
            operations[plan.id] = resp.operations[0];
          }
        }));
        setPlanOperations(operations);
      } catch (e) {
        // ignore errors
      }
    };

    fetchOps();
  }, [config?.plans?.length]);

  const fetchDockerResources = async () => {
    setIsLoading(true);
    try {
      const resp = await backrestService.discoverDocker({});
      setContainers(resp.containers);
      setIsRemote(resp.hostIsRemote);
    } catch (e: any) {
      alerts.error(formatErrorAlert(e, m.dashboard_error_fetch()));
    } finally {
      setIsLoading(false);
    }
  };

  const toggleVolume = (containerId: string, sourcePath: string) => {
    const key = `${containerId}:${sourcePath}`;
    setSelectedVolumes((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  const handleBackupPlan = async (planId: string) => {
    try {
      await backrestService.backup(create(BackupRequestSchema, { value: planId }));
      alerts.success(m.plan_backup_scheduled());
    } catch (e: any) {
      alerts.error(formatErrorAlert(e, m.plan_error_backup()));
    }
  };

  const handleRestorePlan = async (planId: string, volumeName: string, originalPath: string) => {
    const plan = config?.plans.find(p => p.id === planId);
    if (!plan) return;
    
    showModal(
      <DockerRestoreModal
        planId={planId}
        repoId={plan.repo}
        volumeName={volumeName}
        originalPath={originalPath}
        onClose={() => showModal(null)}
      />
    );
  };

  const handleShowLogs = (operation: Operation) => {
    showModal(
      <DialogRoot open={true} onOpenChange={(e) => !e.open && showModal(null)} size="cover">
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Operation Details: {operation.id.toString()}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <OperationRow operation={operation} />
          </DialogBody>
          <DialogFooter>
            <DialogCloseTrigger asChild>
              <Button variant="outline" onClick={() => showModal(null)}>{m.button_close()}</Button>
            </DialogCloseTrigger>
          </DialogFooter>
        </DialogContent>
      </DialogRoot>
    );
  };

  const getPlanTemplateForVolume = (container: DockerContainer, volume: any) => {
    const preHooks: string[] = [];
    const postHooks: string[] = [];

    // Expanded smart hooks detection (best effort defaults)
    const image = container.image.toLowerCase();
    if (image.includes("postgres")) {
      preHooks.push(`docker exec ${container.name} pg_dumpall -U postgres > /tmp/dump.sql # Note: ensure PGPASSWORD is set or .pgpass exists`);
      postHooks.push(`rm /tmp/dump.sql`);
    } else if (image.includes("mysql")) {
      preHooks.push(`docker exec ${container.name} mysqldump --all-databases > /tmp/dump.sql # Note: ensure credentials in /root/.my.cnf`);
      postHooks.push(`rm /tmp/dump.sql`);
    } else if (image.includes("mariadb")) {
      preHooks.push(`docker exec ${container.name} mariadb-dump --all-databases > /tmp/dump.sql`);
      postHooks.push(`rm /tmp/dump.sql`);
    } else if (image.includes("redis")) {
      preHooks.push(`docker exec ${container.name} redis-cli save`);
    } else if (image.includes("mongo")) {
      preHooks.push(`docker exec ${container.name} mongodump --out /tmp/dump`);
      postHooks.push(`rm -rf /tmp/dump`);
    }

    const hooks = preHooks.map(command => ({
      command,
      condition: [1 /* CONDITION_SNAPSHOT_START */],
    }));
    hooks.push(...postHooks.map(command => ({
      command,
      condition: [3 /* CONDITION_SNAPSHOT_END */],
    })));

    return create(PlanSchema, {
      id: `docker-${container.name}-${volume.name || "vol"}`,
      repo: selectedRepo,
      paths: [volume.source],
      hooks,
      schedule: {
        schedule: {
          case: "cron",
          value: "0 3 * * *",
        },
      },
      retention: {
        policy: {
          case: "policyKeepLastN",
          value: 30,
        },
      },
    });
  };

  const handleCreatePlans = async () => {
    if (!selectedRepo) {
      alerts.error(m.add_plan_modal_validation_repository_required());
      return;
    }

    const plansToCreate: CreateDockerPlansRequest["plans"] = [];

    containers.forEach((container) => {
      container.volumes.forEach((volume) => {
        if (selectedVolumes[`${container.id}:${volume.source}`]) {
          const def = create(DockerPlanDefinitionSchema, {
            containerName: container.name,
            volumeName: volume.name,
            path: volume.source,
          });

          const template = getPlanTemplateForVolume(container, volume);
          def.preHooks = template.hooks.filter(h => h.condition.includes(1)).map(h => h.command);
          def.postHooks = template.hooks.filter(h => h.condition.includes(3)).map(h => h.command);
          
          plansToCreate.push(def);
        }
      });
    });

    if (plansToCreate.length === 0) {
      return;
    }

    setIsSubmitting(true);
    try {
      const newConfig = await backrestService.createDockerPlans({
        plans: plansToCreate,
        repoId: selectedRepo,
        schedule: {
          schedule: {
            value: "0 3 * * *",
            case: "cron",
          },
        },
        retention: {
          policy: {
            value: 30,
            case: "policyKeepLastN",
          },
        },
      });
      setConfig(newConfig);
      alerts.success(m.docker_create_plans_success());
      setSelectedVolumes({});
      fetchDockerResources();
    } catch (e: any) {
      alerts.error(formatErrorAlert(e, m.add_plan_modal_error_operation_prefix()));
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCreateSinglePlan = (container: DockerContainer, volume: any) => {
    if (!selectedRepo) {
      alerts.error(m.add_plan_modal_validation_repository_required());
      return;
    }

    showModal(
      <AddPlanModal 
        template={getPlanTemplateForVolume(container, volume)} 
      />
    );
  };

  const filteredContainers = useMemo(() => {
    if (!searchQuery) return containers;
    const q = searchQuery.toLowerCase();
    return containers.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.image.toLowerCase().includes(q) ||
        c.volumes.some(
          (v) =>
            v.source.toLowerCase().includes(q) ||
            v.destination.toLowerCase().includes(q) ||
            v.name.toLowerCase().includes(q),
        ),
    );
  }, [containers, searchQuery]);

  const groupedContainers = useMemo(() => {
    if (!groupByProject) return { "": filteredContainers };
    const groups: Record<string, DockerContainer[]> = {};
    filteredContainers.forEach((c) => {
      const project = c.composeProject || "Other";
      if (!groups[project]) groups[project] = [];
      groups[project].push(c);
    });
    return groups;
  }, [filteredContainers, groupByProject]);

  const selectedCount = Object.values(selectedVolumes).filter(Boolean).length;

  const repoCollection = createListCollection({
    items: config?.repos.map((r) => ({ label: r.id, value: r.id })) || [],
  });

  return (
    <Stack gap={6} width="full">
      <Flex justify="space-between" align="center" flexWrap="wrap" gap={4}>
        <Flex align="center" gap={4}>
          <Heading size="lg">{m.docker_discovery_title()}</Heading>
          {isRemote && (
            <Tooltip content="Backrest is connected to a remote Docker host via DOCKER_HOST. Paths cannot be verified locally.">
              <Badge colorPalette="blue" variant="solid" size="md">
                <FiRadio style={{ marginRight: "4px" }} /> Remote Host
              </Badge>
            </Tooltip>
          )}
        </Flex>
        <Flex gap={2}>
          <SetupHelper containers={containers} selectedVolumes={selectedVolumes} />
          <Button
            colorPalette="blue"
            onClick={handleCreatePlans}
            loading={isSubmitting}
            disabled={selectedCount === 0}
          >
            <FiPlus /> {m.docker_create_plans()} ({selectedCount})
          </Button>
        </Flex>
      </Flex>

      <Stack gap={4} p={4} bg="bg.panel" borderRadius="md" borderWidth="1px">
        <SimpleGrid columns={[1, 1, 2]} gap={4}>
          <Box>
            <Text fontWeight="bold" mb={2}>{m.docker_select_repo()}</Text>
            <SelectRoot
              collection={repoCollection}
              value={[selectedRepo]}
              onValueChange={(e) => setSelectedRepo(e.value[0])}
            >
              <SelectTrigger>
                <SelectValueText placeholder={m.add_plan_modal_field_repository_select()} />
              </SelectTrigger>
              <SelectContent>
                {repoCollection.items.map((repo) => (
                  <SelectItem item={repo} key={repo.value}>
                    {repo.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectRoot>
          </Box>
          <Box>
            <Text fontWeight="bold" mb={2}>{m.docker_search_placeholder()}</Text>
            <InputGroup width="full" startElement={<FiSearch />}>
              <Input
                placeholder={m.docker_search_placeholder()}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </InputGroup>
          </Box>
        </SimpleGrid>

        <Flex align="center" gap={2}>
          <Switch
            id="group-by-project"
            checked={groupByProject}
            onCheckedChange={(e) => setGroupByProject(!!e.checked)}
          />
          <Text as="label" cursor="pointer" onClick={() => setGroupByProject(!groupByProject)}>
            {m.docker_group_by_project()}
          </Text>
        </Flex>
      </Stack>

      <Stack gap={8}>
        {Object.entries(groupedContainers).map(([project, projectContainers]) => (
          <Box key={project}>
            {groupByProject && (
              <Flex align="center" gap={2} mb={4}>
                <Heading size="md">{project}</Heading>
                <Badge variant="subtle">{projectContainers.length}</Badge>
                <Separator flex="1" />
              </Flex>
            )}
            <Stack gap={4}>
              {projectContainers.map((container) => (
                <ContainerCard
                  key={container.id}
                  container={container}
                  selectedVolumes={selectedVolumes}
                  onToggleVolume={toggleVolume}
                  onBackupNow={handleBackupPlan}
                  onRestore={handleRestorePlan}
                  onCreatePlan={handleCreateSinglePlan}
                  onShowLogs={handleShowLogs}
                  planOperations={planOperations}
                />
              ))}
            </Stack>
          </Box>
        ))}
      </Stack>
    </Stack>
  );
};

const LastSnapshotInfo = ({ operation }: { operation: Operation }) => {
  let snapshotId = "";
  if (operation.op.case === "operationIndexSnapshot") {
    snapshotId = operation.op.value.snapshot?.id || "";
  } else if (operation.op.case === "operationBackup") {
    snapshotId = operation.op.value.lastStatus?.entry.case === "summary" ? operation.op.value.lastStatus.entry.value.snapshotId : "";
  }

  if (!snapshotId) return null;

  const time = new Date(Number(operation.unixTimeStartMs));
  const diff = Date.now() - time.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  let ageStr = "";
  if (days > 0) ageStr = `${days}d ago`;
  else if (hours > 0) ageStr = `${hours}h ago`;
  else ageStr = `${minutes}m ago`;

  return (
    <Flex align="center" gap={1} color="fg.muted" fontSize="2xs">
      <FiClock size={10} />
      <Text fontWeight="medium">{m.op_type_snapshot()}:</Text>
      <Code fontSize="3xs" variant="ghost" p={0}>{normalizeSnapshotId(snapshotId)}</Code>
      <Text>({ageStr})</Text>
    </Flex>
  );
};

const StatusBadge = ({ planId, lastOp, onShowLogs }: { planId: string, lastOp?: Operation, onShowLogs: (op: Operation) => void }) => {
  const status = useResourceStatus(
    create(OpSelectorSchema, {
      planId,
    }),
  );

  if (status === OperationStatus.STATUS_UNKNOWN && !lastOp) {
    return null;
  }

  const effectiveStatus = status !== OperationStatus.STATUS_UNKNOWN ? status : (lastOp?.status ?? OperationStatus.STATUS_UNKNOWN);
  const type = lastOp ? displayTypeToString(getTypeForDisplay(lastOp)) : "Op";
  const timeStr = lastOp ? new Date(Number(lastOp.unixTimeStartMs)).toLocaleString() : "";
  const tooltipContent = lastOp ? (
    <Stack gap={1}>
      <Text fontWeight="bold">{type}: {nameForStatus(effectiveStatus)}</Text>
      <Text fontSize="xs">{timeStr}</Text>
      {lastOp.displayMessage && (
        <Box p={2} bg="bg.muted" borderRadius="sm" borderLeftWidth="3px" borderLeftColor={colorForStatus(effectiveStatus)}>
          <Text fontSize="xs" color="fg.error" whiteSpace="pre-wrap">{lastOp.displayMessage}</Text>
        </Box>
      )}
      <Text fontSize="2xs" color="fg.muted">Click to view logs</Text>
    </Stack>
  ) : nameForStatus(effectiveStatus);

  return (
    <Tooltip content={tooltipContent}>
      <Badge
        variant="outline"
        colorPalette={colorForStatus(effectiveStatus)}
        cursor={lastOp ? "pointer" : "default"}
        onClick={(e) => {
          if (lastOp) {
            e.stopPropagation();
            onShowLogs(lastOp);
          }
        }}
      >
        {type}: {nameForStatus(effectiveStatus)}
        {lastOp && <FiExternalLink style={{ marginLeft: "4px", display: "inline" }} />}
      </Badge>
    </Tooltip>
  );
};

const ContainerCard = ({
  container,
  selectedVolumes,
  onToggleVolume,
  onBackupNow,
  onRestore,
  onCreatePlan,
  onShowLogs,
  planOperations,
}: {
  container: DockerContainer;
  selectedVolumes: Record<string, boolean>;
  onToggleVolume: (containerId: string, sourcePath: string) => void;
  onBackupNow: (planId: string) => void;
  onRestore: (planId: string, volumeName: string, originalPath: string) => void;
  onCreatePlan: (container: DockerContainer, volume: any) => void;
  onShowLogs: (operation: Operation) => void;
  planOperations: Record<string, Operation>;
}) => {
  const [isOpen, setIsOpen] = useState(true);

  return (
    <Card.Root width="full">
      <Card.Header p={3} cursor="pointer" onClick={() => setIsOpen(!isOpen)}>
        <Flex justify="space-between" align="center">
          <Flex align="center" gap={3}>
            <FiBox size={20} />
            <Box>
              <Flex align="center" gap={2}>
                <Heading size="sm">{container.name}</Heading>
                <Badge size="xs" colorPalette={container.state === "running" ? "green" : "gray"}>
                  {container.state}
                </Badge>
              </Flex>
              <Text fontSize="xs" color="fg.muted">
                {container.image}
              </Text>
            </Box>
          </Flex>
          <IconButton variant="ghost" size="sm" aria-label="Toggle">
            {isOpen ? <FiChevronUp /> : <FiChevronDown />}
          </IconButton>
        </Flex>
      </Card.Header>
      <Collapsible.Root open={isOpen}>
        <Collapsible.Content>
          <Card.Body pt={0}>
            <Stack gap={3} mt={2}>
              {container.volumes.map((volume) => {
                const isSelected = selectedVolumes[`${container.id}:${volume.source}`];
                const lastOp = volume.planId ? planOperations[volume.planId] : undefined;

                return (
                  <Box
                    key={volume.source}
                    p={3}
                    borderWidth="1px"
                    borderRadius="md"
                    bg={isSelected ? "blue.50" : "transparent"}
                    _dark={{ bg: isSelected ? "blue.950" : "transparent" }}
                    borderColor={isSelected ? "blue.200" : "border"}
                  >
                    <Flex align="center" gap={4}>
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={() => onToggleVolume(container.id, volume.source)}
                        disabled={volume.alreadyBackedUp}
                      />
                      <Box flex="1">
                        <Flex align="center" justify="space-between" gap={2} mb={1}>
                          <Flex align="center" gap={2}>
                            <FiDatabase size={14} />
                            <Text fontWeight="bold" fontSize="sm">
                              {volume.name || "Bind Mount"}
                            </Text>
                            {volume.alreadyBackedUp && !volume.planId && (
                              <Badge colorPalette="green" variant="subtle">
                                <FiCheck size={10} style={{ display: "inline", marginRight: "2px" }} />
                                {m.docker_already_backed_up()}
                              </Badge>
                            )}
                            {volume.planId && (
                              <StatusBadge 
                                planId={volume.planId} 
                                lastOp={lastOp} 
                                onShowLogs={onShowLogs} 
                              />
                            )}
                            {!volume.pathReachable && (
                              <Tooltip content={m.docker_path_not_reachable()}>
                                <Badge colorPalette="orange" variant="subtle">
                                  <FiAlertTriangle size={10} style={{ display: "inline", marginRight: "2px" }} />
                                  Not Reachable
                                </Badge>
                              </Tooltip>
                            )}
                          </Flex>

                          <Flex gap={2}>
                            {volume.alreadyBackedUp && volume.planId ? (
                              <>
                                <Button
                                  size="xs"
                                  variant="outline"
                                  colorPalette="blue"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onBackupNow(volume.planId!);
                                  }}
                                >
                                  <FiPlay /> {m.plan_button_backup()}
                                </Button>
                                <Button
                                  size="xs"
                                  variant="outline"
                                  colorPalette="green"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onRestore(volume.planId!, volume.name, volume.source);
                                  }}
                                >
                                  <FiRefreshCcw /> {m.op_type_restore()}
                                </Button>
                              </>
                            ) : (
                              <Button
                                size="xs"
                                variant="outline"
                                colorPalette="blue"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onCreatePlan(container, volume);
                                }}
                              >
                                <FiPlus /> {m.app_menu_add_plan()}
                              </Button>
                            )}
                          </Flex>
                        </Flex>
                        <SimpleGrid columns={[1, 1, 2]} gap={2}>
                          <Box>
                            <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" fontWeight="bold">
                              {m.docker_source_path()}
                            </Text>
                            <Text fontSize="xs" wordBreak="break-all">
                              {volume.source}
                            </Text>
                          </Box>
                          <Box>
                            <Text fontSize="2xs" color="fg.muted" textTransform="uppercase" fontWeight="bold">
                              {m.docker_destination_path()}
                            </Text>
                            <Text fontSize="xs" wordBreak="break-all">
                              {volume.destination}
                            </Text>
                          </Box>
                        </SimpleGrid>
                        {lastOp && <Box mt={2}><LastSnapshotInfo operation={lastOp} /></Box>}
                      </Box>
                    </Flex>
                  </Box>
                );
              })}
            </Stack>
          </Card.Body>
        </Collapsible.Content>
      </Collapsible.Root>
    </Card.Root>
  );
};

const SetupHelper = ({
  containers,
  selectedVolumes,
}: {
  containers: DockerContainer[];
  selectedVolumes: Record<string, boolean>;
}) => {
  const selectedPaths = useMemo(() => {
    const paths = new Set<string>();
    containers.forEach((c) => {
      c.volumes.forEach((v) => {
        if (selectedVolumes[`${c.id}:${v.source}`] && !v.pathReachable) {
          paths.add(v.source);
        }
      });
    });
    return Array.from(paths);
  }, [containers, selectedVolumes]);

  if (selectedPaths.length === 0) return null;

  const composeFragment = selectedPaths
    .map((p) => `      - ${p}:${p}:ro`)
    .join("\n");
  const runFlags = selectedPaths.map((p) => `-v ${p}:${p}:ro`).join(" ");

  return (
    <DialogRoot size="lg">
      <DialogTrigger asChild>
        <Button variant="outline" colorPalette="orange">
          <FiAlertTriangle /> {m.docker_setup_helper()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{m.docker_setup_helper_title()}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Stack gap={4}>
            <Text fontSize="sm">{m.docker_setup_helper_description()}</Text>

            <Box>
              <Flex justify="space-between" align="center" mb={1}>
                <Text fontSize="xs" fontWeight="bold">{m.docker_setup_helper_compose_fragment()}</Text>
                <IconButton
                  aria-label="Copy"
                  size="xs"
                  variant="ghost"
                  onClick={() => navigator.clipboard.writeText(composeFragment)}
                >
                  <FiClipboard />
                </IconButton>
              </Flex>
              <Code display="block" p={2} whiteSpace="pre" fontSize="xs">
                {composeFragment}
              </Code>
            </Box>

            <Box>
              <Flex justify="space-between" align="center" mb={1}>
                <Text fontSize="xs" fontWeight="bold">{m.docker_setup_helper_run_flags()}</Text>
                <IconButton
                  aria-label="Copy"
                  size="xs"
                  variant="ghost"
                  onClick={() => navigator.clipboard.writeText(runFlags)}
                >
                  <FiClipboard />
                </IconButton>
              </Flex>
              <Code display="block" p={2} fontSize="xs">
                {runFlags}
              </Code>
            </Box>
          </Stack>
        </DialogBody>
        <DialogFooter>
          <DialogCloseTrigger asChild>
            <Button variant="outline">{m.button_close()}</Button>
          </DialogCloseTrigger>
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
};
