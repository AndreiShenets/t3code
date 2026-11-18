import { CaseSensitiveIcon, RegexIcon, SearchIcon, WholeWordIcon, XIcon } from "lucide-react";
import { useDeferredValue, useId, useState } from "react";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Toggle } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  createDiffFileMatcher,
  DEFAULT_DIFF_FILE_FILTER,
  type DiffFileFilterValue,
} from "./diffFileFilter.logic";

export function useDiffFileFilter() {
  const [value, setValue] = useState(DEFAULT_DIFF_FILE_FILTER);
  const deferredValue = useDeferredValue(value);
  return { value, setValue, ...createDiffFileMatcher(deferredValue) };
}

export function DiffFileFilter({
  value,
  onChange,
}: {
  readonly value: DiffFileFilterValue;
  readonly onChange: (value: DiffFileFilterValue) => void;
}) {
  const errorId = useId();
  const { error } = createDiffFileMatcher(value);
  return (
    <div>
      <InputGroup role="search" aria-label="Filter changed files">
        <InputGroupAddon>
          <SearchIcon className="size-3.5" />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          size="sm"
          aria-label="Filter files"
          placeholder="Filter files"
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : errorId}
          value={value.query}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onChange({ ...value, query: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing) {
              event.stopPropagation();
              onChange({ ...value, query: "" });
            }
          }}
        />
        <InputGroupAddon align="inline-end">
          {(
            [
              ["caseSensitive", "Match case", CaseSensitiveIcon],
              ["wholeWord", "Match whole word", WholeWordIcon],
              ["regex", "Use regular expression", RegexIcon],
            ] as const
          ).map(([key, label, Icon]) => (
            <Tooltip key={key}>
              <TooltipTrigger
                render={
                  <Toggle
                    size="sm"
                    variant="ghost"
                    aria-label={label}
                    pressed={value[key]}
                    onPressedChange={(pressed) => onChange({ ...value, [key]: pressed })}
                  />
                }
              >
                <Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup>{label}</TooltipPopup>
            </Tooltip>
          ))}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Clear file filter"
            disabled={value.query === ""}
            onClick={() => onChange({ ...value, query: "" })}
          >
            <XIcon className="size-3.5" />
          </Button>
        </InputGroupAddon>
      </InputGroup>
      {error !== null ? (
        <p id={errorId} role="status" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
