import React, { useEffect, useState, useMemo } from "react";
import {
  Stack,
  Text,
  Box,
  Flex,
  Table,
  Badge,
  Spinner,
  Center,
  createListCollection,
} from "@chakra-ui/react";
import { Button } from "../../components/ui/button";
import {
  SelectRoot,
  SelectTrigger,
  SelectValueText,
  SelectContent,
  SelectItem,
} from "../../components/ui/select";
import { backrestService } from "../../api/client";
import {
  DiffSnapshotsRequestSchema,
  DiffEntry,
  ListSnapshotsRequestSchema,
} from "../../../gen/ts/v1/service_pb";
import { ResticSnapshot } from "../../../gen/ts/v1/restic_pb";
import { create } from "@bufbuild/protobuf";
import { FormModal } from "../../components/common/FormModal";
import { alerts, formatErrorAlert } from "../../components/common/Alerts";
import * as m from "../../paraglide/messages";
import { formatBytes, normalizeSnapshotId } from "../../lib/formatting";

export const SnapshotDiffModal = ({
  repoId,
  baseSnapshotId,
  onClose,
}: {
  repoId: string;
  baseSnapshotId: string;
  onClose: () => void;
}) => {
  const [targetSnapshotId, setTargetSnapshotId] = useState("");
  const [snapshots, setSnapshots] = useState<ResticSnapshot[]>([]);
  const [diffEntries, setDiffEntries] = useState<DiffEntry[]>([]);
  const [isLoadingSnapshots, setIsLoadingSnapshots] = useState(false);
  const [isDiffing, setIsDiffing] = useState(false);

  useEffect(() => {
    const fetchSnapshots = async () => {
      setIsLoadingSnapshots(true);
      try {
        const resp = await backrestService.listSnapshots(
          create(ListSnapshotsRequestSchema, { repoId })
        );
        // Filter out the base snapshot and sort by time (newest first)
        const filtered = resp.snapshots
          .filter((s) => s.id !== baseSnapshotId)
          .sort((a, b) => {
            if (b.unixTimeMs > a.unixTimeMs) return 1;
            if (b.unixTimeMs < a.unixTimeMs) return -1;
            return 0;
          });
        setSnapshots(filtered);
      } catch (e: any) {
        alerts.error(formatErrorAlert(e, "Failed to fetch snapshots"));
      } finally {
        setIsLoadingSnapshots(false);
      }
    };
    fetchSnapshots();
  }, [repoId, baseSnapshotId]);

  const handleDiff = async () => {
    if (!targetSnapshotId) return;
    setIsDiffing(true);
    try {
      const resp = await backrestService.diffSnapshots(
        create(DiffSnapshotsRequestSchema, {
          repoId,
          snapshotIdBase: baseSnapshotId,
          snapshotIdTarget: targetSnapshotId,
        })
      );
      setDiffEntries(resp.entries);
    } catch (e: any) {
      alerts.error(formatErrorAlert(e, "Failed to compare snapshots"));
    } finally {
      setIsDiffing(false);
    }
  };

  const snapshotCollection = useMemo(() => createListCollection({
    items: snapshots.map((s) => ({
      label: `${normalizeSnapshotId(s.id!).slice(0, 8)} (${new Date(Number(s.unixTimeMs)).toLocaleString()})`,
      value: s.id!,
    })),
  }), [snapshots]);

  return (
    <FormModal
      title={m.snapshot_diff_title()}
      isOpen={true}
      onClose={onClose}
      size="xl"
      footer={
        <Button variant="ghost" onClick={onClose}>
          {m.button_close()}
        </Button>
      }
    >
      <Stack gap={6}>
        <Box p={4} bg="bg.panel" borderRadius="md" borderWidth="1px">
          <Stack gap={4}>
            <Text fontWeight="bold">{m.snapshot_diff_select_target()}</Text>
            <Flex gap={2}>
              <Box flex="1">
                <SelectRoot
                  collection={snapshotCollection}
                  value={[targetSnapshotId]}
                  onValueChange={(e) => setTargetSnapshotId(e.value[0])}
                  disabled={isLoadingSnapshots || isDiffing}
                  positioning={{ strategy: "fixed" }}
                >
                  <SelectTrigger>
                    <SelectValueText placeholder={m.snapshot_diff_select_target()} />
                  </SelectTrigger>
                  <SelectContent zIndex={2000}>
                    {snapshotCollection.items.map((item) => (
                      <SelectItem item={item} key={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </SelectRoot>
              </Box>
              <Button
                colorPalette="blue"
                onClick={handleDiff}
                loading={isDiffing}
                disabled={!targetSnapshotId}
              >
                {m.snapshot_diff_compare()}
              </Button>
            </Flex>
          </Stack>
        </Box>

        {isDiffing ? (
          <Center py={10}>
            <Spinner />
          </Center>
        ) : diffEntries.length > 0 ? (
          <Box overflowY="auto" maxH="400px">
            <Table.Root size="sm" variant="outline">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Path</Table.ColumnHeader>
                  <Table.ColumnHeader>Type</Table.ColumnHeader>
                  <Table.ColumnHeader>Change</Table.ColumnHeader>
                  <Table.ColumnHeader align="right">Size</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {diffEntries.map((entry, idx) => (
                  <Table.Row key={idx}>
                    <Table.Cell wordBreak="break-all">{entry.path}</Table.Cell>
                    <Table.Cell>{entry.type}</Table.Cell>
                    <Table.Cell>
                      <Badge
                        colorPalette={
                          entry.change === "added"
                            ? "green"
                            : entry.change === "removed"
                            ? "red"
                            : "orange"
                        }
                      >
                        {entry.change}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell align="right">
                      {entry.size > 0 ? formatBytes(Number(entry.size)) : "-"}
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
        ) : targetSnapshotId && !isDiffing ? (
            <Center py={10}>
                <Text color="fg.muted">No differences found between these snapshots.</Text>
            </Center>
        ) : null}
      </Stack>
    </FormModal>
  );
};
