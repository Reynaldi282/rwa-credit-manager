"use client";

import { Bot, ShieldCheck, Zap } from "lucide-react";
import { toast } from "sonner";
import { PreviewStatus, explorerTxUrl, fmtPct, fmtUsd, previewStatusLabel, shortAddress, shortHash } from "@rwa/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useActions } from "@/hooks/use-actions";
import { useDashboard } from "@/hooks/use-dashboard";
import { useKeeper } from "@/hooks/use-keeper";
import { StatusPill, type Tone } from "./primitives";

const statusTone: Record<PreviewStatus, Tone> = {
  [PreviewStatus.Executable]: "warning",
  [PreviewStatus.PolicyDisabled]: "neutral",
  [PreviewStatus.NoDebt]: "neutral",
  [PreviewStatus.BelowTrigger]: "good",
  [PreviewStatus.CooldownActive]: "serious",
  [PreviewStatus.NoReserve]: "critical",
  [PreviewStatus.InvalidPrice]: "critical",
};

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular ${strong ? "font-semibold text-foreground" : "text-ink-secondary"}`}>{value}</span>
    </div>
  );
}

export function ProtectionEngine() {
  const d = useDashboard();
  const a = useActions();
  const keeper = useKeeper();
  const pv = d.preview;
  const policy = d.policy;
  const status = (pv?.status ?? PreviewStatus.NoDebt) as PreviewStatus;
  const label = status === PreviewStatus.BelowTrigger ? "Armed — below trigger" : status === PreviewStatus.Executable ? "Trigger reached — executable" : previewStatusLabel[status];

  const runKeeper = () => {
    if (!d.address || !d.market) return;
    keeper.trigger.mutate(
      { user: d.address, marketId: d.market.id },
      {
        onSuccess: (r) => {
          const ex = r.executions[0];
          if (!ex) return void toast.info("Keeper checked your position", { description: r.checks[0] ? "No execution needed right now." : "Position not registered (save a policy first)." });
          if (ex.outcome === "executed") {
            const url = ex.txHash ? explorerTxUrl(d.chainId, ex.txHash) : undefined;
            toast.success("Keeper executed protection", {
              description: `Repaid ${fmtUsd(BigInt(ex.assetsRepaid ?? 0))} · LTV now ${fmtPct(BigInt(ex.ltvAfter ?? 0))} · ${shortHash(ex.txHash)}`,
              action: url ? { label: "Etherscan", onClick: () => window.open(url, "_blank", "noopener") } : undefined,
            });
          } else toast.warning(`Keeper: ${ex.outcome}`, { description: ex.reason });
        },
        onError: (e) => toast.error("Keeper unreachable", { description: e.message }),
      },
    );
  };

  return (
    <Card className="h-full" data-testid="protection-engine">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-muted-foreground" /> Protection engine
        </CardTitle>
        <CardDescription>Live preview from <code className="text-xs">previewProtection()</code> on-chain</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <StatusPill tone={statusTone[status]} className="text-sm" testId="protection-status">
          {label}
        </StatusPill>

        {pv && (
          <div className="divide-y divide-border rounded-lg bg-background/40 px-3 ring-1 ring-border">
            <Row label="Current LTV / trigger" value={`${fmtPct(pv.currentLtv)} / ${policy && policy.triggerLtv > 0n ? fmtPct(policy.triggerLtv, 0) : "—"}`} strong />
            <Row label="Repayment to reach target" value={pv.debt > 0n && policy?.enabled ? fmtUsd(pv.requiredRepay) : "—"} />
            <Row label="Repayment this execution" value={status === PreviewStatus.Executable ? fmtUsd(pv.repayAmount) : "—"} strong />
            <Row label="Expected debt after" value={status === PreviewStatus.Executable ? fmtUsd(pv.expectedDebtAfter) : "—"} />
            <Row label="Expected LTV after" value={status === PreviewStatus.Executable ? fmtPct(pv.expectedLtvAfter) : "—"} />
            <Row label="Reserve after" value={status === PreviewStatus.Executable ? fmtUsd(pv.reserveAfter) : fmtUsd(d.risk?.reserve ?? 0n)} />
          </div>
        )}

        {pv && status === PreviewStatus.Executable && !pv.targetReachable && (
          <Alert className="border-warning/40">
            <AlertTitle>Partial protection only</AlertTitle>
            <AlertDescription>
              Reserve or per-execution cap can’t restore the {policy ? fmtPct(policy.targetLtv, 0) : ""} target. LTV would end at {fmtPct(pv.expectedLtvAfter)} — this
              position will <b>not</b> be reported as fully protected. Top up the reserve.
            </AlertDescription>
          </Alert>
        )}

        <div className="grid gap-2 sm:grid-cols-2">
          <Button onClick={() => a.executeProtection()} disabled={!pv?.executable || a.busy || !d.address} data-testid="execute-protection">
            <Zap /> Execute protection
          </Button>
          <Button variant="outline" onClick={runKeeper} disabled={!keeper.configured || !d.address || keeper.trigger.isPending} data-testid="run-keeper">
            <Bot /> {keeper.trigger.isPending ? "Keeper running…" : "Run keeper now"}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          Keeper:
          {!keeper.configured ? (
            <StatusPill tone="neutral">not configured</StatusPill>
          ) : keeper.online ? (
            <StatusPill tone="good">online · {shortAddress(keeper.health?.keeper)}</StatusPill>
          ) : (
            <StatusPill tone="critical">offline</StatusPill>
          )}
          {keeper.health?.lastTickAt && <span>last check {new Date(keeper.health.lastTickAt).toLocaleTimeString()}</span>}
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          Automatic protection depends on a keeper being online and its transaction being included on-chain — it is not guaranteed. Anyone may
          call <code>executeProtection</code>, but it only repays <i>your</i> Morpho debt with <i>your</i> reserve, and only once your trigger is
          reached. {policy && policy.lastExecutedAt > 0n ? `Last executed ${new Date(Number(policy.lastExecutedAt) * 1000).toLocaleString()}.` : ""}
        </p>
      </CardContent>
    </Card>
  );
}
