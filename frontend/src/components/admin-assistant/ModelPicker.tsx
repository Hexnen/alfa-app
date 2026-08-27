import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Star } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { AdminAssistantModel, AdminAssistantModels } from "@/lib/api";
import { fmtContext, fmtPrice, isRecommendedModel, RECOMMENDED_MODELS } from "./helpers";


/** Polecane na górę (w kolejności stałej), reszta bez zmian. */
function sortRecommendedFirst(list: AdminAssistantModel[]) {
  const rec = RECOMMENDED_MODELS.map((id) => list.find((m) => m.id === id)).filter((m): m is AdminAssistantModel => !!m);
  if (rec.length === 0) return list;
  return [...rec, ...list.filter((m) => !isRecommendedModel(m.id))];
}

/** Combobox modelu (input + filtrowana lista) — bez Popover/Command w ui. */
export function ModelPicker({
  value,
  onChange,
  models,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  models: AdminAssistantModels | null;
  placeholder: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listId = "assistant-model-listbox";
  const hasList = !!models && !models.error && models.models.length > 0;

  const filtered = useMemo(() => {
    if (!models || !hasList) return [];
    const q = query.trim().toLowerCase();
    const all = models.models;
    const hit = q ? all.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : all;
    return sortRecommendedFirst(hit).slice(0, 200);
  }, [models, query, hasList]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const setQ = (q: string) => {
    setQuery(q);
    setHi(0);
  };

  const pick = (id: string) => {
    onChange(id);
    setQuery("");
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="relative">
      <Input
        id="assistant-model"
        value={open ? query : value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={open && hasList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label="Identyfikator modelu"
        onFocus={() => {
          if (hasList) {
            setQ(value);
            setOpen(true);
          }
        }}
        onChange={(e) => {
          const v = e.target.value;
          if (open) setQ(v);
          onChange(v);
        }}
        onKeyDown={(e) => {
          if (!open || !hasList) return;
          if (e.key === "Escape") {
            setOpen(false);
            e.preventDefault();
          } else if (e.key === "ArrowDown") {
            setHi((h) => Math.min(h + 1, filtered.length - 1));
            e.preventDefault();
          } else if (e.key === "ArrowUp") {
            setHi((h) => Math.max(h - 1, 0));
            e.preventDefault();
          } else if (e.key === "Enter" && filtered[hi]) {
            pick(filtered[hi].id);
            e.preventDefault();
          }
        }}
        className="pr-8 font-mono text-xs"
      />
      {hasList && (
        <button
          type="button"
          tabIndex={-1}
          aria-label={open ? "Zwiń listę modeli" : "Rozwiń listę modeli"}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
          onClick={() => {
            if (open) setOpen(false);
            else {
              setQ("");
              setOpen(true);
              document.getElementById("assistant-model")?.focus();
            }
          }}
        >
          <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
        </button>
      )}
      {open && hasList && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Lista modeli"
          className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {filtered.length === 0 && (
            <li className="px-2 py-2 text-xs text-muted-foreground">Brak modeli pasujących do „{query}”. Możesz wpisać ID ręcznie.</li>
          )}
          {filtered.map((m, i) => {
            const rec = isRecommendedModel(m.id);
            return (
              <li
                key={m.id}
                role="option"
                aria-selected={m.id === value}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(m.id);
                }}
                onMouseEnter={() => setHi(i)}
                className={cn(
                  "cursor-pointer rounded-sm px-2 py-1.5 text-xs",
                  i === hi ? "bg-accent text-accent-foreground" : "",
                  m.id === value && "font-semibold"
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {rec && <Star className="h-3.5 w-3.5 shrink-0 fill-amber-400 text-amber-500" aria-label="Polecany" role="img" />}
                    <span className="truncate">{m.name || m.id}</span>
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">ctx {fmtContext(m.contextLength)}</span>
                </div>
                <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                  <span className="truncate font-mono">{m.id}</span>
                  <span className="shrink-0">{fmtPrice(m)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
