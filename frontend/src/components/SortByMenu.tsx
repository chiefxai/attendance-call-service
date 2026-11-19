import { useId, useState } from "react";
import { Button, Menu, MenuItem } from "@mui/material";
import SortRoundedIcon from "@mui/icons-material/SortRounded";

export type SortOption<Value extends string> = { value: Value; label: string };

export function SortByMenu<Value extends string>({
  value,
  options,
  onChange,
}: {
  value: Value;
  options: readonly SortOption<Value>[];
  onChange: (value: Value) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();
  const selectedLabel = options.find((option) => option.value === value)?.label || "Default";

  return <>
    <Button
      size="small"
      variant="outlined"
      startIcon={<SortRoundedIcon />}
      onClick={(event) => setAnchor(event.currentTarget)}
      aria-haspopup="menu"
      aria-expanded={Boolean(anchor)}
      aria-controls={anchor ? menuId : undefined}
    >
      Sort by: {selectedLabel}
    </Button>
    <Menu id={menuId} anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
      {options.map((option) => <MenuItem
        key={option.value}
        selected={option.value === value}
        onClick={() => { onChange(option.value); setAnchor(null); }}
      >{option.label}</MenuItem>)}
    </Menu>
  </>;
}
