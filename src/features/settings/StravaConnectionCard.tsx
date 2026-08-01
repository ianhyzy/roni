"use client";

import { useState } from "react";
import { useAction, useQuery } from "convex/react";
import {
  CheckCircle2,
  ExternalLink,
  Info,
  Link2,
  Loader2,
  RefreshCw,
  TriangleAlert,
  Unlink,
} from "lucide-react";
import { api } from "../../../convex/_generated/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type StravaAction = "connect" | "sync" | "disconnect" | null;

export type StravaConnectionNotice = {
  kind: "success" | "error" | "warning";
  message: string;
};

interface StravaConnectionCardProps {
  configured: boolean;
  callbackNotice?: StravaConnectionNotice;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

export function StravaConnectionCard({ configured, callbackNotice }: StravaConnectionCardProps) {
  const status = useQuery(api.strava.status.getMyStravaStatus, {});
  const startOAuth = useAction(api.strava.oauthFlow.startStravaOAuth);
  const refreshData = useAction(api.strava.sync.refreshStravaData);
  const disconnect = useAction(api.strava.disconnect.disconnectMyStrava);
  const [activeAction, setActiveAction] = useState<StravaAction>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [message, setMessage] = useState<StravaConnectionNotice | null>(null);
  const [showRevocationLink, setShowRevocationLink] = useState(false);
  const busy = activeAction !== null;

  const handleConnect = async () => {
    setActiveAction("connect");
    setMessage(null);
    setShowRevocationLink(false);
    try {
      const result = await startOAuth({});
      if (!result.success) {
        setMessage({ kind: "error", message: result.error });
        setActiveAction(null);
        return;
      }
      window.location.href = result.authorizeUrl;
    } catch (error) {
      setMessage({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to start Strava connection.",
      });
      setActiveAction(null);
    }
  };

  const handleSync = async () => {
    setActiveAction("sync");
    setMessage(null);
    setShowRevocationLink(false);
    try {
      const result = await refreshData({});
      setMessage(
        result.success
          ? {
              kind: "success",
              message: `Strava synced ${result.activities} ${result.activities === 1 ? "activity" : "activities"}.`,
            }
          : { kind: "error", message: result.error },
      );
    } catch (error) {
      setMessage({
        kind: "error",
        message: error instanceof Error ? error.message : "Strava sync failed.",
      });
    } finally {
      setActiveAction(null);
    }
  };

  const handleDisconnect = async () => {
    setActiveAction("disconnect");
    setMessage(null);
    setShowRevocationLink(false);
    try {
      const result = await disconnect({});
      if (!result.success) {
        setMessage({ kind: "error", message: result.error });
        return;
      }
      const revocationFailed = result.revocation === "failed";
      setShowRevocationLink(revocationFailed);
      setMessage({
        kind: revocationFailed ? "warning" : "success",
        message: revocationFailed
          ? "Strava disconnected and local imported data was removed, but Strava could not confirm access revocation."
          : "Strava disconnected. Local imported data was removed.",
      });
    } catch (error) {
      setMessage({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to disconnect Strava.",
      });
    } finally {
      setActiveAction(null);
      setDisconnectOpen(false);
    }
  };

  if (status === undefined) {
    return (
      <Card>
        <CardContent
          className="flex items-center gap-2 p-4 text-sm text-muted-foreground"
          role="status"
          aria-busy="true"
        >
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Loading Strava status…
        </CardContent>
      </Card>
    );
  }

  const visibleMessage = message ?? callbackNotice ?? null;
  const MessageIcon =
    visibleMessage?.kind === "error"
      ? TriangleAlert
      : visibleMessage?.kind === "warning"
        ? Info
        : CheckCircle2;

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium text-foreground">
                {status.state === "active"
                  ? "Connected"
                  : status.state === "disconnected"
                    ? "Disconnected"
                    : "Not connected"}
              </p>
              <Badge variant={status.state === "active" ? "secondary" : "outline"}>Strava</Badge>
              <Badge variant="outline">Public activities only</Badge>
            </div>
            {status.state === "active" ? (
              <div className="text-sm text-muted-foreground">
                <p>Connected {formatDate(status.connectedAt)}</p>
                {status.lastSyncedAt ? <p>Last synced {formatDate(status.lastSyncedAt)}</p> : null}
              </div>
            ) : status.state === "disconnected" ? (
              <p className="text-sm text-muted-foreground">
                Disconnected {formatDate(status.disconnectedAt)}
              </p>
            ) : null}
            <p className="mt-2 text-sm text-muted-foreground">
              Imports activity summaries for training-load context. Roni requests read-only access
              to public activities (activity:read); private activities are not imported.
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Strava data does not include lifting sets or reps, change Tonal strength scores,
              detect PRs, or publish workouts.
            </p>
          </div>

          <div className="flex shrink-0 flex-col gap-2 sm:min-w-36">
            {status.state === "active" ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  className="min-h-11 w-full gap-1.5"
                  disabled={busy || !configured}
                  onClick={handleSync}
                >
                  {activeAction === "sync" ? (
                    <Loader2
                      className="size-3.5 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <RefreshCw className="size-3.5" aria-hidden="true" />
                  )}
                  {activeAction === "sync" ? "Syncing…" : "Sync now"}
                </Button>
                <Dialog open={disconnectOpen} onOpenChange={setDisconnectOpen}>
                  <DialogTrigger
                    render={
                      <Button
                        variant="outline"
                        size="sm"
                        className="min-h-11 w-full gap-1.5"
                        disabled={busy}
                      />
                    }
                  >
                    <Unlink className="size-3.5" aria-hidden="true" />
                    Disconnect
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Disconnect Strava?</DialogTitle>
                      <DialogDescription>
                        Roni will delete your imported Strava activities. This does not delete
                        anything from Strava.
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <DialogClose
                        render={<Button variant="outline" className="min-h-11" disabled={busy} />}
                      >
                        Cancel
                      </DialogClose>
                      <Button
                        variant="destructive"
                        className="min-h-11"
                        disabled={busy}
                        onClick={handleDisconnect}
                      >
                        {activeAction === "disconnect" ? "Disconnecting…" : "Disconnect Strava"}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </>
            ) : (
              <Button
                size="sm"
                className="min-h-11 w-full gap-1.5"
                disabled={busy || !configured}
                onClick={handleConnect}
              >
                {activeAction === "connect" ? (
                  <Loader2
                    className="size-3.5 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <Link2 className="size-3.5" aria-hidden="true" />
                )}
                {activeAction === "connect" ? "Connecting…" : "Connect Strava"}
              </Button>
            )}
          </div>
        </div>

        {!configured ? (
          <Alert className="mt-3 border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200">
            <Info className="size-4" aria-hidden="true" />
            <AlertDescription>
              {status.state === "active"
                ? "Strava sync is unavailable because this deployment is no longer configured. You can still disconnect."
                : "Strava connection is unavailable because this deployment is not configured."}
            </AlertDescription>
          </Alert>
        ) : null}
        <div role="status" aria-live="polite" aria-atomic="true">
          {visibleMessage ? (
            <Alert
              role="presentation"
              variant={visibleMessage.kind === "error" ? "destructive" : "default"}
              className={cn(
                "mt-3",
                visibleMessage.kind === "warning" &&
                  "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
              )}
            >
              <MessageIcon className="size-4" aria-hidden="true" />
              <AlertDescription>
                {visibleMessage.message}
                {showRevocationLink ? (
                  <a
                    className="mt-1 flex w-fit items-center gap-1 underline underline-offset-2"
                    href="https://www.strava.com/settings/apps"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Review Strava connected apps
                    <ExternalLink className="size-3" aria-hidden="true" />
                  </a>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
