import { usePerms } from "@/auth/permissions";
import { useTechnikMe } from "./me";

/**
 * DOSTĘP DO PANELU — klucz uprawnień `technik` (grupa „Technik”).
 *
 * `view` = podgląd zleceń, `edit` = Rozpocznij/Zakończ, notatki i protokół.
 *
 * Źródłem prawdy dla `canEdit` jest `GET /technik/me` — backend liczy je tym
 * samym `canEdit(user, "technik")`, którym broni każdej mutacji, więc UI nigdy
 * nie pokaże przycisku kończącego się 403. Lustro z `usePerms()` działa jako
 * zapasowa odpowiedź, zanim `me` się wczyta (inaczej pasek akcji migałby przy
 * każdym wejściu na zlecenie).
 */
export function useTechnikAccess() {
  const perms = usePerms();
  const { me } = useTechnikMe();
  const isTechnikRole = perms.user?.role === "technik";
  return {
    user: perms.user,
    isTechnikRole,
    canView: isTechnikRole || perms.canView("technik"),
    canEdit: me ? me.canEdit : isTechnikRole || perms.canEdit("technik"),
  };
}
