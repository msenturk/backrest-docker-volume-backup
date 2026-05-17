import React, { useEffect, useState } from "react";
import { Box, Flex, Stack, Text, Badge } from "@chakra-ui/react";
import { FiFolder, FiServer, FiArrowDown, FiActivity, FiChevronDown, FiChevronUp } from "react-icons/fi";
import { backrestService } from "../../api/client";
import { isWindows } from "../../state/buildcfg";
import * as m from "../../paraglide/messages";

interface VolumeMount {
  name: string;
  source: string;
  destination: string;
  readOnly: boolean;
}

interface ActiveMountsListProps {
  currentValue?: string;
  title?: string;
  description?: string;
}

export const ActiveMountsList: React.FC<ActiveMountsListProps> = ({
  currentValue = "",
  title,
  description
}) => {
  const [mounts, setMounts] = useState<VolumeMount[]>([]);
  const [loading, setLoading] = useState(true);
  const [isOpen, setIsOpen] = useState(false);

  // Fallback to internationalized defaults if props are not explicitly provided
  const displayTitle = title || m.active_mounts_title_default();
  const displayDescription = description || m.active_mounts_desc_default();

  useEffect(() => {
    if (isWindows) {
      setLoading(false);
      return;
    }

    backrestService
      .discoverDocker({})
      .then((res: any) => {
        // Find our own container (backrest) with robust check
        const backrestCont = res.containers?.find((c: any) => {
          const nameLower = c.name?.toLowerCase() || "";
          const imageLower = c.image?.toLowerCase() || "";
          return (
            nameLower === "backrest" ||
            nameLower.includes("backrest") ||
            imageLower.includes("backrest") ||
            (c.id && c.id.slice(0, 12) === window.location.hostname)
          );
        });
        if (backrestCont && backrestCont.volumes) {
          setMounts(backrestCont.volumes);
        }
      })
      .catch((err) => console.error("Failed to load backrest mounts:", err))
      .finally(() => setLoading(false));
  }, []);

  if (isWindows || loading || mounts.length === 0) {
    return null;
  }

  // Checks if the mount destination path matches a configured path
  const isPathMatched = (mountDest: string, currentVal: string) => {
    if (!currentVal) return false;
    // Split by comma in case multiple paths are joined (e.g. from plan paths array)
    const paths = currentVal.split(",").map((p) => p.trim()).filter(Boolean);
    return paths.some((path) => {
      if (path.includes("://")) return false; // Skip URIs (e.g. s3://bucket/path)
      
      // Normalize paths by removing trailing slash for robust comparison
      const cleanPath = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
      const cleanDest = mountDest.endsWith("/") && mountDest.length > 1 ? mountDest.slice(0, -1) : mountDest;
      
      return (
        cleanPath === cleanDest ||
        cleanPath.startsWith(cleanDest + "/")
      );
    });
  };

  // Check if there is currently any match to highlight
  const hasMatch = mounts.some((mount) => isPathMatched(mount.destination, currentValue));

  return (
    <Box
      borderWidth="1px"
      borderColor="border.subtle"
      borderRadius="lg"
      p={3.5}
      bg="bg.panel"
      boxShadow="sm"
      mt={3.5}
      width="full"
      overflow="hidden"
      transition="all 0.2s cubic-bezier(0.16, 1, 0.3, 1)"
      _hover={{ borderColor: "blue.500", boxShadow: "md" }}
    >
      {/* Foldable Header */}
      <Flex
        align="center"
        justify="space-between"
        width="full"
        cursor="pointer"
        onClick={() => setIsOpen(!isOpen)}
        userSelect="none"
        py={0.5}
      >
        <Flex align="center" gap={2.5}>
          <FiActivity style={{ color: "#3b82f6", flexShrink: 0 }} size={14} />
          <Text fontWeight="bold" fontSize="xs" color="fg.default">
            {displayTitle}
          </Text>
          {hasMatch && (
            <Badge colorPalette="blue" variant="solid" fontSize="9px" px={2} borderRadius="full">
              {m.active_mounts_match_found()}
            </Badge>
          )}
        </Flex>
        {isOpen ? (
          <FiChevronUp size={16} style={{ color: "#71717a", flexShrink: 0 }} />
        ) : (
          <FiChevronDown size={16} style={{ color: "#71717a", flexShrink: 0 }} />
        )}
      </Flex>

      {/* Foldable Content */}
      {isOpen && (
        <Box mt={3} width="full">
          <Text fontSize="10px" color="fg.muted" mb={3.5}>
            {displayDescription}
          </Text>

          <Stack gap={3} width="full">
            {mounts.map((mount) => {
              const isMatched = isPathMatched(mount.destination, currentValue);

              return (
                <Flex
                  key={mount.destination}
                  direction="column"
                  p={3}
                  borderRadius="md"
                  borderWidth="1px"
                  bg={isMatched ? "blue.subtle" : "bg.muted"}
                  borderColor={isMatched ? "blue.subtle" : "border.subtle"}
                  transition="all 0.2s cubic-bezier(0.16, 1, 0.3, 1)"
                  _hover={isMatched ? { bg: "blue.subtle", borderColor: "blue.500" } : { bg: "bg.muted", borderColor: "border" }}
                  gap={2}
                  width="full"
                  overflow="hidden"
                >
                  {/* Host Path (Top) */}
                  <Flex align="center" justify="space-between" width="full" gap={2} overflow="hidden">
                    <Flex align="center" gap={2.5} minWidth={0} overflow="hidden">
                      <FiServer size={13} style={{ color: isMatched ? "#2563eb" : "#71717a", flexShrink: 0 }} />
                      <Text
                        fontSize="11px"
                        fontWeight="medium"
                        color="fg.default"
                        fontFamily="mono"
                        whiteSpace="nowrap"
                        overflow="hidden"
                        textOverflow="ellipsis"
                        title={mount.source}
                      >
                        {mount.source}
                      </Text>
                    </Flex>
                    <Badge variant="outline" size="sm" flexShrink={0} fontSize="9px" px={1.5}>
                      {m.active_mounts_host()}
                    </Badge>
                  </Flex>

                  {/* Visual Divider / Connection Arrow */}
                  <Flex align="center" px={1} gap={2} width="full">
                    <Box h="1px" bg="border.subtle" flex={1} />
                    <FiArrowDown size={11} style={{ color: isMatched ? "#2563eb" : "#a1a1aa", flexShrink: 0 }} />
                    <Box h="1px" bg="border.subtle" flex={1} />
                  </Flex>

                  {/* Container Path (Bottom) */}
                  <Flex align="center" justify="space-between" width="full" gap={2} overflow="hidden">
                    <Flex align="center" gap={2.5} minWidth={0} overflow="hidden">
                      <FiFolder size={13} style={{ color: isMatched ? "#2563eb" : "#71717a", flexShrink: 0 }} />
                      <Text
                        fontSize="11px"
                        fontWeight="bold"
                        color="fg.default"
                        fontFamily="mono"
                        whiteSpace="nowrap"
                        overflow="hidden"
                        textOverflow="ellipsis"
                        title={mount.destination}
                      >
                        {mount.destination}
                      </Text>
                    </Flex>
                    <Badge
                      colorPalette={isMatched ? "blue" : "gray"}
                      variant={isMatched ? "solid" : "outline"}
                      size="sm"
                      flexShrink={0}
                      fontSize="9px"
                      px={1.5}
                    >
                      {isMatched ? m.active_mounts_active() : m.active_mounts_container()}
                    </Badge>
                  </Flex>
                </Flex>
              );
            })}
          </Stack>
        </Box>
      )}
    </Box>
  );
};
