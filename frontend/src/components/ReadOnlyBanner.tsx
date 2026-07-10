import { Eye } from "lucide-react";

/**
 * Baner informujący, że użytkownik ma dostęp tylko do odczytu w danej sekcji.
 * Renderować na górze strony, gdy usePerms().canEdit(tabKey) === false.
 */
export function ReadOnlyBanner({ className = "" }: { className?: string }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400 ${className}`}
    >
      <Eye className="h-4 w-4 shrink-0" />
      <span>Tryb tylko do odczytu — brak uprawnień do edycji tej sekcji.</span>
    </div>
  );
}
