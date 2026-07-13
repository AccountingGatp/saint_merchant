"use client";

import { useRef, useState, type DragEvent } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type UploadSlot = {
  id: string;
  index: number;
  label: string;
  purpose: string;
  /** Expected filename hint, used for a soft match warning. */
  expected: string;
};

type Props = {
  slot: UploadSlot;
  file: File | null;
  onFileChange: (file: File | null) => void;
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isCsv(file: File): boolean {
  return (
    file.type === "text/csv" ||
    file.type === "application/vnd.ms-excel" ||
    file.name.toLowerCase().endsWith(".csv")
  );
}

export function FileUploadCard({ slot, file, onFileChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accept = (selected: File | null) => {
    if (!selected) {
      onFileChange(null);
      setError(null);
      return;
    }
    if (!isCsv(selected)) {
      setError("Only .csv files are accepted.");
      return;
    }
    setError(null);
    onFileChange(selected);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const dropped = e.dataTransfer.files?.[0] ?? null;
    accept(dropped);
  };

  const filled = Boolean(file);

  return (
    <Card
      className={cn(
        "gap-0 rounded-lg py-0 transition-colors",
        filled && "bg-emerald-500/5 ring-emerald-500/40",
        dragActive && "ring-2 ring-primary/40",
        error && "ring-destructive/50",
      )}
    >
      <CardContent className="flex flex-col gap-2 p-2.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
              filled
                ? "bg-emerald-500 text-white"
                : "bg-muted text-muted-foreground",
            )}
          >
            {filled ? "✓" : slot.index}
          </span>
          <p className="min-w-0 flex-1 truncate text-xs font-medium">
            {slot.label}
          </p>
        </div>

        <div
          role="button"
          tabIndex={0}
          title={slot.purpose}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
          className={cn(
            "flex min-h-[44px] cursor-pointer items-center justify-center rounded-md border border-dashed px-2.5 py-2 text-center text-xs transition-colors",
            "hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            dragActive && "border-primary bg-primary/5",
          )}
        >
          {file ? (
            <div className="flex w-full items-center justify-between gap-2">
              <div className="min-w-0 text-left">
                <p className="truncate font-medium text-foreground">
                  {file.name}
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {formatSize(file.size)}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 shrink-0 px-2 text-[11px] text-destructive hover:text-destructive"
                onClick={(e) => {
                  e.stopPropagation();
                  accept(null);
                  if (inputRef.current) inputRef.current.value = "";
                }}
              >
                Remove
              </Button>
            </div>
          ) : (
            <span className="text-muted-foreground">
              <span className="font-medium text-foreground">Click</span> or drag
              &amp; drop · CSV
            </span>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => accept(e.target.files?.[0] ?? null)}
          />
        </div>

        {error && (
          <p className="text-[11px] font-medium text-destructive">{error}</p>
        )}
      </CardContent>
    </Card>
  );
}
