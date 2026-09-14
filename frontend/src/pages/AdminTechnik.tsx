import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, Plus, RefreshCw, RotateCcw, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { adminTechnikApi, type AdminTechnikActivities } from "@/lib/api";
import { ErrorBox, SectionCard, SourceBadge } from "@/components/admin-assistant/shared";
import { errMsg, useFlash } from "@/components/admin-assistant/helpers";

/**
 * Administracja → Panel technika. Jedna sekcja: słownik czynności, które panel
 * podpowiada technikowi chipami nad polem „Wykonane czynności” w protokole.
 *
 * Wzorzec strony jak w AdminCalendar/AdminAssistant: szkic w stanie lokalnym →
 * sticky pasek „niezapisane zmiany” → zapis całości jednym PUT-em. Lista jest
 * uporządkowana (kolejność = kolejność chipów), więc edytujemy ją strzałkami,
 * a nie przeciąganiem: na liście kilkunastu pozycji drag&drop to więcej kodu
 * i więcej sposobów, żeby zgubić wpis.
 */
export function AdminTechnik() {
  const [settings, setSettings] = useState<AdminTechnikActivities | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [newItem, setNewItem] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, flash] = useFlash();
  const newItemRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const s = await adminTechnikApi.activities();
    setSettings(s);
    setDraft(null);
  }, []);

  useEffect(() => {
    load().catch((e) => setLoadError(errMsg(e, "Nie udało się wczytać ustawień panelu technika")));
  }, [load]);

  const saved = useMemo(() => settings?.values.activities ?? [], [settings]);
  const list = draft ?? saved;
  const dirty = draft !== null && (draft.length !== saved.length || draft.some((v, i) => v !== saved[i]));
  const maxLength = settings?.meta?.maxLength ?? 120;
  const maxItems = settings?.meta?.maxItems ?? 60;

  // Ostrzeżenie przeglądarki przy wyjściu z niezapisanym słownikiem.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const edit = (next: string[]) => setDraft(next);

  const add = () => {
    const value = newItem.trim();
    if (!value) return;
    // Duplikaty i tak wycina backend — tu mówimy o tym od razu, zamiast
    // pozwolić adminowi zapisać listę, która wróci krótsza.
    if (list.some((v) => v.toLocaleLowerCase("pl") === value.toLocaleLowerCase("pl"))) {
      setError(`Czynność „${value}” jest już na liście.`);
      return;
    }
    if (list.length >= maxItems) {
      setError(`Lista może mieć najwyżej ${maxItems} pozycji.`);
      return;
    }
    setError(null);
    edit([...list, value.slice(0, maxLength)]);
    setNewItem("");
    newItemRef.current?.focus();
  };

  const move = (idx: number, delta: number) => {
    const to = idx + delta;
    if (to < 0 || to >= list.length) return;
    const next = [...list];
    const [item] = next.splice(idx, 1);
    next.splice(to, 0, item);
    edit(next);
  };

  const save = async () => {
    if (!dirty || draft === null) return;
    setSaving(true);
    setError(null);
    try {
      setSettings(await adminTechnikApi.updateActivities(draft));
      setDraft(null);
      flash("Słownik czynności zapisany.");
    } catch (e) {
      setError(errMsg(e, "Nie udało się zapisać słownika"));
    } finally {
      setSaving(false);
    }
  };

  const restoreDefaults = async () => {
    setSaving(true);
    setError(null);
    try {
      setSettings(await adminTechnikApi.updateActivities(null));
      setDraft(null);
      flash("Przywrócono słownik domyślny.");
    } catch (e) {
      setError(errMsg(e, "Nie udało się przywrócić domyślnych"));
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <div className="space-y-3">
        <ErrorBox>{loadError}</ErrorBox>
        <Button
          variant="outline"
          onClick={() =>
            load()
              .then(() => setLoadError(null))
              .catch((e) => setLoadError(errMsg(e, "Błąd")))
          }
        >
          <RefreshCw className="mr-1 h-4 w-4" /> Spróbuj ponownie
        </Button>
      </div>
    );
  }
  if (!settings) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Wczytywanie ustawień…
      </div>
    );
  }

  return (
    <div className="space-y-3 pb-24">
      {error && <ErrorBox>{error}</ErrorBox>}
      {notice && (
        <div
          className="rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2 text-sm text-green-700 dark:text-green-400"
          role="status"
        >
          {notice}
        </div>
      )}

      <SectionCard
        id="czynnosci"
        title="Czynności podpowiadane technikowi w protokole"
        description="Technik tapie chip nad polem „Wykonane czynności”, a treść dopisuje się nową linią — drugi tap ją usuwa. Kolejność na liście to kolejność chipów. Pusta lista = brak podpowiedzi (pole zostaje zwykłą notatką)."
      >
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <SourceBadge source={settings.sources?.activities} />
          <span data-testid="technik-activities-count">
            Pozycji: <strong className="tabular-nums text-foreground">{list.length}</strong> / {maxItems}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 text-muted-foreground"
            onClick={() => void restoreDefaults()}
            disabled={saving}
            title="Usuń wpis z bazy — wróci słownik domyślny"
          >
            <RotateCcw className="mr-1 h-3.5 w-3.5" /> Przywróć domyślne
          </Button>
        </div>

        <ul className="space-y-2" data-testid="technik-activities-list">
          {list.map((item, idx) => (
            <li key={idx} className="flex items-center gap-1.5">
              <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {idx + 1}.
              </span>
              <Input
                value={item}
                maxLength={maxLength}
                aria-label={`Czynność ${idx + 1}`}
                data-testid={`technik-activity-${idx}`}
                onChange={(e) => edit(list.map((v, i) => (i === idx ? e.target.value : v)))}
                className="flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0"
                aria-label={`Przenieś wyżej: ${item}`}
                disabled={idx === 0}
                onClick={() => move(idx, -1)}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0"
                aria-label={`Przenieś niżej: ${item}`}
                disabled={idx === list.length - 1}
                onClick={() => move(idx, 1)}
              >
                <ArrowDown className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-9 w-9 shrink-0 text-destructive"
                aria-label={`Usuń: ${item}`}
                onClick={() => edit(list.filter((_, i) => i !== idx))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
          {list.length === 0 && (
            <li className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
              Lista jest pusta — technik nie zobaczy żadnych chipów nad polem „Wykonane czynności”.
            </li>
          )}
        </ul>

        <div className="flex gap-2">
          <Input
            ref={newItemRef}
            value={newItem}
            maxLength={maxLength}
            placeholder="Nowa czynność, np. Wymiana akumulatora centrali"
            data-testid="technik-activity-new"
            onChange={(e) => setNewItem(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button type="button" variant="outline" onClick={add} disabled={!newItem.trim()}>
            <Plus className="mr-1 h-4 w-4" /> Dodaj
          </Button>
        </div>
      </SectionCard>

      {dirty && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur lg:left-64"
          role="region"
          aria-label="Niezapisane zmiany"
        >
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="text-sm">
              <span className="font-medium">Niezapisane zmiany</span>{" "}
              <span className="text-muted-foreground">(słownik czynności)</span>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setDraft(null)} disabled={saving}>
                Odrzuć
              </Button>
              <Button type="button" data-testid="technik-activities-save" onClick={() => void save()} disabled={saving}>
                {saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />} Zapisz
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
