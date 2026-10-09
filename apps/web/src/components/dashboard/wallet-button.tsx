"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, Copy, LogOut, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from "wagmi";
import { anvilLocal, shortAddress } from "@rwa/shared";
import { Button } from "@/components/ui/button";
import { env } from "@/lib/env";
import { visibleChains, type AppChainId } from "@/lib/wagmi";
import { useDashboard } from "@/hooks/use-dashboard";

function connectorLabel(c: { id: string; name: string; type: string }) {
  if (c.type === "mock") return "Anvil dev wallet (local only)";
  if (c.id === "injected") return "Browser wallet (injected)";
  return c.name;
}

export function WalletButton() {
  const { address, isConnected, connector } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const d = useDashboard();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  // false during SSR / hydration, true afterwards (wallet state only exists in the browser)
  const mounted = useSyncExternalStore(() => () => {}, () => true, () => false);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  if (!mounted) return <Button variant="outline" size="lg" disabled>Connect wallet</Button>;

  // Prefer EIP-6963-discovered wallets (MetaMask, …); keep the generic injected one only as a fallback.
  const discovered = connectors.filter((c) => c.type === "injected" && c.id !== "injected");
  const list = [...discovered, ...connectors.filter((c) => (c.id === "injected" && discovered.length === 0) || c.type === "mock")];

  if (!isConnected) {
    return (
      <div className="relative" ref={ref}>
        <Button size="lg" onClick={() => setOpen((o) => !o)} disabled={connect.isPending} data-testid="connect-wallet">
          <Wallet /> {connect.isPending ? "Connecting…" : "Connect wallet"}
        </Button>
        {open && (
          <div className="absolute right-0 z-40 mt-2 w-72 rounded-xl bg-popover p-2 shadow-xl ring-1 ring-border">
            {list.length === 0 && (
              <a className="block rounded-lg px-3 py-2 text-sm hover:bg-accent" href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer">
                No wallet detected — install MetaMask
              </a>
            )}
            {list.map((c) => (
              <button
                key={c.uid}
                type="button"
                data-testid={`connector-${c.type === "mock" ? "dev" : c.id}`}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-accent"
                onClick={() => {
                  setOpen(false);
                  connect.mutate(
                    { connector: c, chainId: (c.type === "mock" ? anvilLocal.id : env.defaultChainId) as AppChainId },
                    { onError: (e) => toast.error("Connection failed", { description: e.message.split("\n")[0] }) },
                  );
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- wallet-provided data: URI icon */}
                {c.icon ? <img src={c.icon} alt="" className="size-5" /> : <Wallet className="size-5 text-muted-foreground" />}
                {connectorLabel(c)}
              </button>
            ))}
            <p className="px-3 pt-2 pb-1 text-[11px] leading-snug text-muted-foreground">
              Testnet only. Never use a wallet holding real funds for demos.
            </p>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="relative flex items-center gap-2" ref={ref}>
      {d.isWrongNetwork && (
        <Button variant="destructive" size="lg" onClick={() => switchChain.mutate({ chainId: env.defaultChainId as AppChainId })}>
          Switch network
        </Button>
      )}
      <Button variant="outline" size="lg" onClick={() => setOpen((o) => !o)} data-testid="wallet-menu">
        <span className="size-2 rounded-full bg-good" aria-hidden />
        <span className="font-mono">{shortAddress(address)}</span>
        <ChevronDown className="text-muted-foreground" />
      </Button>
      {open && (
        <div className="absolute top-full right-0 z-40 mt-2 w-64 rounded-xl bg-popover p-2 shadow-xl ring-1 ring-border">
          <div className="px-3 py-2 text-xs text-muted-foreground">
            {connector ? connectorLabel(connector) : "Wallet"}
            <div className="mt-1 font-mono text-[11px] break-all text-ink-secondary">{address}</div>
          </div>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-accent"
            onClick={() => {
              void navigator.clipboard.writeText(address ?? "");
              toast.success("Address copied");
            }}
          >
            <Copy className="size-4" /> Copy address
          </button>
          <div className="my-1 h-px bg-border" />
          <div className="px-3 pt-1 pb-1 text-[11px] text-muted-foreground">Network</div>
          {visibleChains.map((c) => (
            <button
              key={c.id}
              type="button"
              className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm hover:bg-accent"
              onClick={() => switchChain.mutate({ chainId: c.id as AppChainId }, { onError: (e) => toast.error("Switch failed", { description: e.message.split("\n")[0] }) })}
            >
              {c.name}
              {d.connectedChainId === c.id && <span className="text-xs text-good">● connected</span>}
            </button>
          ))}
          <div className="my-1 h-px bg-border" />
          <button type="button" className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-accent" onClick={() => disconnect.mutate()}>
            <LogOut className="size-4" /> Disconnect
          </button>
        </div>
      )}
    </div>
  );
}
