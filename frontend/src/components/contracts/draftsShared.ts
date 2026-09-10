/**
 * Czyste drobiazgi modułu „Drafty umów”: wariant badge'a statusu, obiekt dla
 * pickera i stały fetcher podpowiedzi.
 *
 * Bez Reacta (osobny plik od komponentów — fast refresh nie lubi modułów
 * mieszających jedno z drugim), tak jak `components/interventions/helpers.ts`.
 */
import {
  contractDraftsApi,
  type ContractDraft,
  type ContractDraftStatus,
  type InterventionPickObject,
} from "@/lib/api";
import type { ObjectPickerFetcher } from "@/components/interventions/ObjectPicker";

/**
 * Podpowiedzi obiektów z endpointu draftów (`/contracts/drafts/pick/objects`) —
 * dzięki temu wystarczy klucz `contracts`, bez dostępu do kartoteki obiektów.
 * STAŁA modułu, nie funkcja tworzona w renderze: `ObjectPicker` trzyma fetcher
 * w zależnościach efektu z debounce.
 */
export const draftObjectsFetcher: ObjectPickerFetcher = async (q) =>
  (await contractDraftsApi.pickObjects(q)).data?.items ?? [];

/** Kolor badge'a statusu draftu — podpisany, żeby nie trzeba było rzutować. */
export const STATUS_VARIANT: Record<
  ContractDraftStatus,
  "default" | "secondary" | "success" | "destructive" | "outline" | "info"
> = {
  draft: "secondary",
  sent: "info",
  signed: "success",
  rejected: "destructive",
  archived: "outline",
};

/** Obiekt draftu w kształcie, którego oczekuje `ObjectPicker`. */
export const draftPickObject = (d: ContractDraft): InterventionPickObject => ({
  id: d.objectId,
  name: d.objectName,
  address: d.objectAddress,
  city: d.objectCity,
  contractorName: d.contractorName,
  companyId: d.companyId,
  companyName: d.companyName,
});
