import React, {
  useEffect,
  useState,
  useMemo,
  useRef,
  useCallback,
} from "react";
import { createListCollection } from "@chakra-ui/react";
import {
  ComboboxRoot,
  ComboboxInput,
  ComboboxContent,
  ComboboxItem,
  ComboboxControl,
  ComboboxEmpty,
} from "../ui/combobox";
import { debounce } from "../../lib/util";
import { backrestService } from "../../api/client";
import { isWindows } from "../../state/buildcfg";
import { StringList } from "../../../gen/ts/types/value_pb";

const sep = isWindows ? "\\" : "/";

export const URIAutocomplete = (props: any) => {
  // Extract specific props we handle manually, pass rest to Root
  const { value, onChange, placeholder, disabled, ...rest } = props;

  // value is string
  const [items, setItems] = useState<{ label: string; value: string }[]>([]);
  const lastQueryRef = useRef<string>("");
  const [knownMounts, setKnownMounts] = useState<string[]>([]);

  useEffect(() => {
    if (!isWindows) {
      backrestService
        .pathAutocomplete({ value: "/" })
        .then((res: any) => {
          if (res.values) {
            setKnownMounts(res.values);
          }
        })
        .catch((e) => console.error("Path autocomplete mounts fetch error:", e));
    }
  }, []);

  // Create collection for Combobox
  const collection = useMemo(
    () =>
      createListCollection({
        items: items.filter((i) => i.value.startsWith(value || "")),
      }),
    [items, value],
  );

  const doFetch = useCallback((inputVal: string) => {
    const lastSlash = inputVal.lastIndexOf(sep);
    let searchVal = inputVal;
    if (lastSlash !== -1) {
      searchVal = inputVal.substring(0, lastSlash);
    } else if (searchVal === "") {
      // preserve behavior for relative/empty inputs if needed
      if (inputVal !== "") return;
    }

    // Special handling for root on unix
    if (searchVal === "" && inputVal.startsWith("/")) {
      searchVal = "";
    }

    const query = searchVal + sep;
    lastQueryRef.current = query;

    backrestService
      .pathAutocomplete({ value: query })
      .then((res: StringList) => {
        // Prevent race conditions: ignore if query has changed since this request
        if (lastQueryRef.current !== query) return;

        if (!res.values) {
          setItems([]);
          return;
        }
        const newItems = res.values.map((v) => {
          let fullPath = v;
          if (!v.startsWith("/") && !v.includes(":\\") && !v.startsWith("\\\\")) {
            fullPath = searchVal + sep + v;
          }
          return {
            label: fullPath,
            value: fullPath,
          };
        });
        setItems(newItems);
      })
      .catch((e) => console.error("Path autocomplete error:", e));
  }, []);

  // Debounced fetch
  const debouncedFetch = useMemo(() => debounce(doFetch, 300), [doFetch]);

  const handleInputValueChange = (e: any) => {
    const val = e.inputValue;
    if (onChange) onChange(val);

    // If typing a separator, fetch immediately. Otherwise debounce.
    if (val.endsWith(sep)) {
      debouncedFetch.cancel();
      doFetch(val);
    } else {
      debouncedFetch(val);
    }
  };

  const handleOpenChange = (e: any) => {
    if (e.open) {
      debouncedFetch.cancel();
      doFetch(value || "");
    }
  };

  return (
    <ComboboxRoot
      collection={collection}
      disabled={disabled}
      inputValue={value || ""}
      onInputValueChange={handleInputValueChange}
      onOpenChange={handleOpenChange}
      allowCustomValue
      inputBehavior="autocomplete"
      // @ts-ignore
      width="full"
      style={{ width: "100%" }}
      {...rest}
    >
      <ComboboxControl hideTrigger>
        {/* @ts-ignore */}
        <ComboboxInput placeholder={placeholder} style={{ width: "100%" }} />
      </ComboboxControl>
      <ComboboxContent zIndex={2000}>
        {collection.items.map((item) => {
          // If running on Unix (Docker) and it's a known mount point from the backend
          const isContainerMount =
            !isWindows &&
            item.value !== "/" &&
            knownMounts.includes(item.value);

          return (
            <ComboboxItem key={item.value} item={item}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", gap: "8px" }}>
                <span>{item.label}</span>
                {isContainerMount && (
                  <span style={{
                    fontSize: "10px",
                    padding: "2px 6px",
                    borderRadius: "4px",
                    backgroundColor: "#e0f2fe",
                    color: "#0369a1",
                    fontWeight: "bold",
                    border: "1px solid #bae6fd",
                    whiteSpace: "nowrap"
                  }}>
                    Mounted Volume
                  </span>
                )}
              </div>
            </ComboboxItem>
          );
        })}
      </ComboboxContent>
    </ComboboxRoot>
  );
};
