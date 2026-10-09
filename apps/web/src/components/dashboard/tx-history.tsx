"use client";

import { ExternalLink, History } from "lucide-react";
import { explorerTxUrl } from "@rwa/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDashboard } from "@/hooks/use-dashboard";
import { useOnchainHistory } from "@/hooks/use-history";
import { useLocalTxs } from "@/hooks/use-tx";
import { StatusPill, TxLink } from "./primitives";

type Row = {
  key: string;
  type: string;
  detail: string;
  time?: number;
  status: "confirmed" | "pending" | "failed";
  hash: string;
  highlight?: boolean;
  source: "event" | "wallet";
};

export function TxHistory() {
  const d = useDashboard();
  const history = useOnchainHistory();
  const local = useLocalTxs();

  const onchain: Row[] = (history.data ?? []).map((h) => ({
    key: h.key,
    type: h.type,
    detail: h.detail,
    time: h.timestamp,
    status: "confirmed",
    hash: h.hash,
    highlight: h.highlight,
    source: "event",
  }));
  const seen = new Set(onchain.map((r) => r.hash.toLowerCase()));
  // Wallet-side entries for txs without an indexed event here (approvals) or not yet mined / failed.
  const fromWallet: Row[] = local
    .filter((t) => t.chainId === d.chainId && d.address && t.from.toLowerCase() === d.address.toLowerCase() && !seen.has(t.hash.toLowerCase()))
    .map((t) => ({ key: t.hash, type: t.label, detail: t.error ?? t.amount ?? "", time: t.timestamp, status: t.status, hash: t.hash, source: "wallet" }));
  const rows = [...fromWallet.filter((r) => r.status !== "confirmed"), ...onchain, ...fromWallet.filter((r) => r.status === "confirmed")].sort(
    (a, b) => (b.time ?? Number.MAX_SAFE_INTEGER) - (a.time ?? Number.MAX_SAFE_INTEGER),
  );

  return (
    <Card data-testid="tx-history">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-4 text-muted-foreground" /> Transaction history
        </CardTitle>
        <CardDescription>
          Decoded from on-chain events (RWASafetyGuard, Morpho Blue, test oracle, faucets) for the selected market, plus transactions sent from this
          browser.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!d.address ? (
          <p className="text-sm text-muted-foreground">Connect a wallet to see its history.</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{history.isLoading ? "Reading events…" : history.error ? `Could not read events: ${history.error.message.split("\n")[0]}` : "No transactions yet."}</p>
        ) : (
          <div className="max-h-[420px] overflow-auto rounded-lg ring-1 ring-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Amount / details</TableHead>
                  <TableHead>Timestamp</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Tx hash</TableHead>
                  <TableHead>Explorer</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="tabular">
                {rows.map((r) => {
                  const url = explorerTxUrl(d.chainId, r.hash);
                  return (
                    <TableRow key={r.key} className={r.highlight ? "bg-chart-1/5" : undefined} data-testid={r.highlight ? "history-protection-executed" : undefined}>
                      <TableCell className="font-medium whitespace-nowrap">{r.type}</TableCell>
                      <TableCell className="max-w-[420px] text-xs whitespace-normal text-ink-secondary">{r.detail}</TableCell>
                      <TableCell className="text-xs whitespace-nowrap text-ink-secondary">{r.time ? new Date(r.time).toLocaleString() : "—"}</TableCell>
                      <TableCell>
                        <StatusPill tone={r.status === "confirmed" ? "good" : r.status === "pending" ? "warning" : "critical"}>{r.status}</StatusPill>
                      </TableCell>
                      <TableCell>
                        <TxLink chainId={d.chainId} hash={r.hash} />
                      </TableCell>
                      <TableCell className="text-xs">
                        {url ? (
                          <a className="inline-flex items-center gap-1 text-chart-1 hover:underline" href={r.highlight ? `${url}#eventlog` : url} target="_blank" rel="noopener noreferrer">
                            {r.highlight ? "Event log" : "Etherscan"} <ExternalLink className="size-3" />
                          </a>
                        ) : (
                          <span className="text-muted-foreground">local chain</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
