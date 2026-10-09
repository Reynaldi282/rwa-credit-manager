"use client";

import { useMemo, useState } from "react";
import { PiggyBank, Settings2 } from "lucide-react";
import { parseUnits } from "viem";
import { fmtPct, fmtUsd, pctToWad, wadToNumber } from "@rwa/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { useActions } from "@/hooks/use-actions";
import { useDashboard } from "@/hooks/use-dashboard";

const COOLDOWNS = [
  { v: "0", l: "None" },
  { v: "60", l: "1 minute" },
  { v: "300", l: "5 minutes" },
  { v: "3600", l: "1 hour" },
  { v: "86400", l: "1 day" },
];

type Form = { enabled: boolean; trigger: number; target: number; maxRepay: string; cooldown: string };
const DEFAULT_FORM: Form = { enabled: true, trigger: 70, target: 65, maxRepay: "500", cooldown: "0" };

function parseUsdc(s: string): bigint | undefined {
  try {
    if (!/^\d+(\.\d{0,6})?$/.test(s.trim())) return undefined;
    return parseUnits(s.trim(), 6);
  } catch {
    return undefined;
  }
}

export function ProtectionSettings() {
  const d = useDashboard();
  const a = useActions();
  const lltvPct = d.risk ? wadToNumber(d.risk.lltv) * 100 : 77;

  // The form shows the on-chain policy until the user edits it (then a local draft), no syncing effect needed.
  const p = d.policy;
  const onchain = useMemo<Form>(
    () =>
      p && p.triggerLtv > 0n
        ? {
            enabled: p.enabled,
            trigger: Math.round(wadToNumber(p.triggerLtv) * 10_000) / 100,
            target: Math.round(wadToNumber(p.targetLtv) * 10_000) / 100,
            maxRepay: (Number(p.maxRepayPerExecution) / 1e6).toString(),
            cooldown: String(p.cooldown),
          }
        : DEFAULT_FORM,
    [p],
  );
  const [draft, setDraft] = useState<Form | null>(null);
  const form = draft ?? onchain;
  const { enabled, trigger, target, maxRepay, cooldown } = form;
  const edit = <K extends keyof Form>(k: K) => (v: Form[K]) => setDraft({ ...form, [k]: v });
  const [deposit, setDeposit] = useState("200");
  const [withdraw, setWithdraw] = useState("");

  const maxRepayUnits = parseUsdc(maxRepay);
  const errors: string[] = [];
  if (!(trigger > 0 && trigger < lltvPct)) errors.push(`Trigger must be below the market LLTV (${lltvPct.toFixed(0)}%).`);
  if (!(target > 0 && target < trigger)) errors.push("Target must be below the trigger.");
  if (!maxRepayUnits || maxRepayUnits === 0n) errors.push("Max repayment must be a positive mUSDC amount.");

  const depositUnits = parseUsdc(deposit);
  const withdrawUnits = parseUsdc(withdraw);
  const reserve = d.risk?.reserve ?? 0n;
  const noMarket = !d.market || !d.address;

  const save = async () => {
    const okSaved = await a.savePolicy({
      triggerLtv: pctToWad(trigger),
      targetLtv: pctToWad(target),
      maxRepay: maxRepayUnits!,
      cooldown: BigInt(cooldown),
      enabled,
    });
    if (okSaved) setDraft(null);
  };

  return (
    <Card className="h-full" data-testid="protection-settings">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings2 className="size-4 text-muted-foreground" /> Protection settings
        </CardTitle>
        <CardDescription>Stored on-chain in RWASafetyGuard for the selected market</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between">
          <Label htmlFor="enabled">Enable protection</Label>
          <Switch id="enabled" checked={enabled} onCheckedChange={edit("enabled")} data-testid="policy-enabled" />
        </div>

        <div className="space-y-2">
          <div className="flex justify-between text-sm">
            <Label>Trigger LTV</Label>
            <span className="tabular text-ink-secondary">{trigger.toFixed(1)}%</span>
          </div>
          <Slider min={10} max={Math.max(11, Math.floor(lltvPct) - 0.5)} step={0.5} value={[trigger]} onValueChange={(v) => edit("trigger")(v[0] ?? trigger)} aria-label="Trigger LTV" />
          <div className="flex justify-between text-sm">
            <Label>Target LTV after repayment</Label>
            <span className="tabular text-ink-secondary">{target.toFixed(1)}%</span>
          </div>
          <Slider min={5} max={Math.max(6, trigger - 0.5)} step={0.5} value={[Math.min(target, trigger - 0.5)]} onValueChange={(v) => edit("target")(v[0] ?? target)} aria-label="Target LTV" />
          <p className="text-xs text-muted-foreground">Market liquidation LLTV: {lltvPct.toFixed(0)}% (trigger must stay strictly below it).</p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="max-repay">Max repayment / execution</Label>
            <Input id="max-repay" inputMode="decimal" value={maxRepay} onChange={(e) => edit("maxRepay")(e.target.value)} aria-invalid={!maxRepayUnits} />
          </div>
          <div className="space-y-1.5">
            <Label>Cooldown</Label>
            <Select value={cooldown} onValueChange={edit("cooldown")}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COOLDOWNS.map((c) => (
                  <SelectItem key={c.v} value={c.v}>
                    {c.l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {errors.length > 0 && <ul className="space-y-0.5 text-xs text-destructive">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}

        <div className="flex gap-2">
          <Button className="flex-1" onClick={save} disabled={errors.length > 0 || a.busy || noMarket} data-testid="save-policy">
            Save settings on-chain
          </Button>
          {p?.enabled && (
            <Button variant="outline" onClick={() => a.disableProtection()} disabled={a.busy || noMarket}>
              Disable
            </Button>
          )}
        </div>

        <Separator />

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-medium">
              <PiggyBank className="size-4 text-muted-foreground" /> Protection reserve
            </div>
            <span className="text-sm tabular text-ink-secondary" data-testid="reserve-balance">
              {fmtUsd(reserve)}
            </span>
          </div>
          <div className="flex gap-2">
            <Input inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} aria-label="Deposit amount (mUSDC)" />
            <Button
              variant="secondary"
              onClick={() => depositUnits && a.depositReserve(depositUnits)}
              disabled={!depositUnits || depositUnits === 0n || depositUnits > d.balances.usdc || a.busy || noMarket}
              data-testid="deposit-reserve"
            >
              Deposit
            </Button>
          </div>
          <div className="flex gap-2">
            <Input inputMode="decimal" placeholder="Amount" value={withdraw} onChange={(e) => setWithdraw(e.target.value)} aria-label="Withdraw amount (mUSDC)" />
            <Button variant="outline" onClick={() => withdrawUnits && a.withdrawReserve(withdrawUnits)} disabled={!withdrawUnits || withdrawUnits === 0n || withdrawUnits > reserve || a.busy}>
              Withdraw
            </Button>
            <Button variant="ghost" onClick={() => a.withdrawReserve("max")} disabled={reserve === 0n || a.busy}>
              Max
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Wallet: {fmtUsd(d.balances.usdc)} mUSDC. Unused reserve is always withdrawable to your own wallet; nobody else can move it. Current policy:{" "}
            {p && p.triggerLtv > 0n ? `${fmtPct(p.triggerLtv, 1)} → ${fmtPct(p.targetLtv, 1)}, max ${fmtUsd(p.maxRepayPerExecution)}` : "none"}.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
