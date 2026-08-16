"use client";

import { useEffect, useState } from "react";
import { FileText } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { formatBytes } from "@/lib/fileLimits";

interface FileRow {
  id: string;
  filename: string;
  size: string;
}

const SIDEBAR_LIMIT = 6;

export function FilesList() {
  const [files, setFiles] = useState<FileRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      const { data } = await supabase
        .from("files")
        .select("id, filename, size_bytes")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(SIDEBAR_LIMIT);

      if (cancelled) return;
      const rows = (data ?? []) as Array<{ id: string; filename: string; size_bytes: number }>;
      setFiles(rows.map((f) => ({ id: f.id, filename: f.filename, size: formatBytes(f.size_bytes) })));
      setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loading && files.length === 0) return null;

  return (
    <div className="flex flex-col gap-[3px]">
      <div className="px-3 pb-[7px] font-mono text-[10px] uppercase tracking-[0.13em] text-muted-foreground">Files</div>
      {files.map((f) => (
        <div key={f.id} className="flex items-center gap-[10px] rounded-[7px] px-3 py-2 text-[13.5px] text-foreground">
          <FileText size={14} strokeWidth={1.4} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{f.filename}</span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{f.size}</span>
        </div>
      ))}
    </div>
  );
}
