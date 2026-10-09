"use client";

import type { ReactNode } from "react";
import { CircleCheck, CircleDashed, ExternalLink, Info, OctagonAlert, TriangleAlert } from "lucide-react";
import { explorerAddressUrl, explorerTxUrl, shortAddress, shortHash } from "@rwa/shared";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type Tone = "good" | "warning" | "serious" | "critical" | "neutral" | "info";

const toneIcon: Record<Tone, ReactNode> = {
  good: <CircleCheck className="size-3.5 text-good" aria-hidden />,
  warning: <TriangleAlert className="size-3.5 text-warning" aria-hidden />,
  serious: <TriangleAlert className="size-3.5 text-serious" aria-hidden />,
  critical: <OctagonAlert className="size-3.5 text-critical" aria-hidden />,
  neutral: <CircleDashed className="size-3.5 text-muted-foreground" aria-hidden />,
  info: <Info className="size-3.5 text-chart-1" aria-hidden />,
};

const toneRing: Record<Tone, string> = {
  good: "bg-good/10 ring-good/30",
  warning: "bg-warning/10 ring-warning/30",
  serious: "bg-serious/10 ring-serious/30",
  critical: "bg-critical/10 ring-critical/30",
  neutral: "bg-muted ring-border",
  info: "bg-chart-1/10 ring-chart-1/30",
};

/** Status is never color-alone: icon + label, text in ink color. */
export function StatusPill({ tone, children, className, testId }: { tone: Tone; children: ReactNode; className?: string; testId?: string }) {
  return (
    <span data-testid={testId} data-tone={tone} className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium text-foreground ring-1", toneRing[tone], className)}>
      {toneIcon[tone]}
      {children}
    </span>
  );
}

export function InfoTip({ children }: { children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="inline-flex text-muted-foreground hover:text-foreground" aria-label="More info">
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs leading-relaxed">{children}</TooltipContent>
    </Tooltip>
  );
}

/** Stat tile: label · value · optional sub line. */
export function Metric({
  label,
  value,
  sub,
  tip,
  icon,
  className,
  testId,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tip?: ReactNode;
  icon?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={cn("rounded-xl bg-card p-4 ring-1 ring-border", className)} data-testid={testId}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        <span>{label}</span>
        {tip ? <InfoTip>{tip}</InfoTip> : null}
      </div>
      <div className="mt-1.5 text-xl font-semibold tracking-tight text-foreground">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-ink-secondary">{sub}</div> : null}
    </div>
  );
}

export function TxLink({ chainId, hash, className }: { chainId: number; hash: string; className?: string }) {
  const url = explorerTxUrl(chainId, hash);
  if (!url) return <span className={cn("font-mono text-xs text-ink-secondary", className)} title={`${hash} (local chain — no explorer)`}>{shortHash(hash)}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={cn("inline-flex items-center gap-1 font-mono text-xs text-chart-1 hover:underline", className)}>
      {shortHash(hash)} <ExternalLink className="size-3" />
    </a>
  );
}

export function AddressLink({ chainId, address, className }: { chainId: number; address: string; className?: string }) {
  const url = explorerAddressUrl(chainId, address);
  if (!url) return <span className={cn("font-mono text-xs", className)} title={address}>{shortAddress(address, 6)}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={cn("inline-flex items-center gap-1 font-mono text-xs text-chart-1 hover:underline", className)} title={address}>
      {shortAddress(address, 6)} <ExternalLink className="size-3" />
    </a>
  );
}

export function SectionTitle({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
