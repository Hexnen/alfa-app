import { Card, CardContent } from "@/components/ui/card";
import { FolderKanban } from "lucide-react";

// Placeholder dla głównej zakładki OFI — podzakładki dorobimy później.
export function Ofi() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-3xl font-bold">OFI</h1>
        <p className="text-muted-foreground">
          Obszary funkcjonalne — sekcja w przygotowaniu
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
          <FolderKanban className="h-10 w-10 opacity-50" />
          <p className="text-sm">
            Sekcja OFI jest w przygotowaniu — podzakładki pojawią się wkrótce.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
