"use client";

import { type FormEvent, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { ProviderId } from "../../../convex/ai/providers";
import {
  MAX_PROVIDER_BUDGET_LIMIT_USD,
  MIN_PROVIDER_BUDGET_LIMIT_USD,
} from "../../../lib/aiBudgetPreferences";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const PROVIDER_LABELS: Record<ProviderId, string> = {
  gemini: "Google Gemini",
  claude: "Anthropic Claude",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

type SavingOperation = "ignore" | "limit" | null;

interface BudgetPreferencesProps {
  readonly provider: ProviderId;
  readonly ignoreBudget: boolean;
  readonly budgetLimitUsd: number;
  readonly onIgnoreBudgetChange: (ignoreBudget: boolean) => Promise<unknown>;
  readonly onBudgetLimitSave: (budgetLimitUsd: number) => Promise<unknown>;
}

export function BudgetPreferences({
  provider,
  ignoreBudget,
  budgetLimitUsd,
  onIgnoreBudgetChange,
  onBudgetLimitSave,
}: BudgetPreferencesProps) {
  const sourceKey = `${provider}:${budgetLimitUsd}`;
  const [draftState, setDraftState] = useState({ sourceKey, value: String(budgetLimitUsd) });
  const [savingOperation, setSavingOperation] = useState<SavingOperation>(null);
  const [validationState, setValidationState] = useState<{
    readonly sourceKey: string;
    readonly message: string;
  } | null>(null);
  const providerLabel = PROVIDER_LABELS[provider];
  const inputId = `budget-limit-${provider}`;
  const ignoreBudgetLabelId = `ignore-budget-label-${provider}`;
  const draftLimit = draftState.sourceKey === sourceKey ? draftState.value : String(budgetLimitUsd);
  const validationError = validationState?.sourceKey === sourceKey ? validationState.message : null;

  const handleIgnoreChange = async () => {
    if (savingOperation !== null) return;
    setSavingOperation("ignore");
    try {
      await onIgnoreBudgetChange(!ignoreBudget);
      toast.success(
        ignoreBudget
          ? "Budget guard enabled for all providers"
          : "Budget guard disabled for all providers",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save budget preference");
    } finally {
      setSavingOperation(null);
    }
  };

  const handleLimitSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingOperation !== null) return;

    const parsedLimit = Number(draftLimit);
    if (
      !Number.isFinite(parsedLimit) ||
      parsedLimit < MIN_PROVIDER_BUDGET_LIMIT_USD ||
      parsedLimit > MAX_PROVIDER_BUDGET_LIMIT_USD
    ) {
      setValidationState({
        sourceKey,
        message: `Budget threshold must be between $${MIN_PROVIDER_BUDGET_LIMIT_USD.toFixed(2)} and $${MAX_PROVIDER_BUDGET_LIMIT_USD.toFixed(2)}`,
      });
      return;
    }

    setValidationState(null);
    setSavingOperation("limit");
    try {
      await onBudgetLimitSave(parsedLimit);
      setDraftState({ sourceKey, value: String(parsedLimit) });
      toast.success("Budget threshold saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save budget threshold");
    } finally {
      setSavingOperation(null);
    }
  };

  const parsedDraftLimit = Number(draftLimit);
  const draftIsUnchanged = Number.isFinite(parsedDraftLimit) && parsedDraftLimit === budgetLimitUsd;
  const isSaving = savingOperation !== null;

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div>
          <p className="text-sm font-medium text-foreground">API budget guard</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {providerLabel} is currently selected. The estimated cumulative cost is checked after
            each completed model step. One step can take the estimated cost past the threshold. A
            retry or fallback starts a new model attempt with a fresh threshold.
          </p>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
          <div>
            <p id={ignoreBudgetLabelId} className="text-sm font-medium text-foreground">
              Ignore budget for all providers
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Global setting: skip Roni&apos;s estimated-cost thresholds for every personal provider
              key.
            </p>
          </div>
          <Button
            type="button"
            role="switch"
            aria-labelledby={ignoreBudgetLabelId}
            aria-checked={ignoreBudget}
            variant={ignoreBudget ? "default" : "outline"}
            size="sm"
            disabled={isSaving}
            onClick={handleIgnoreChange}
          >
            {savingOperation === "ignore" && (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            )}
            {ignoreBudget ? "On" : "Off"}
          </Button>
        </div>

        <form className="space-y-3 border-t border-border pt-4" onSubmit={handleLimitSave}>
          <div className="space-y-1.5">
            <Label htmlFor={inputId} className="text-xs text-muted-foreground">
              Per-attempt budget threshold for {providerLabel} (USD)
            </Label>
            <Input
              id={inputId}
              type="number"
              inputMode="decimal"
              min={MIN_PROVIDER_BUDGET_LIMIT_USD}
              max={MAX_PROVIDER_BUDGET_LIMIT_USD}
              step="0.01"
              value={draftLimit}
              onChange={(event) => {
                setDraftState({ sourceKey, value: event.target.value });
                setValidationState(null);
              }}
              aria-invalid={validationError !== null}
              aria-describedby={
                validationError
                  ? `${inputId}-error`
                  : ignoreBudget
                    ? `${inputId}-inactive`
                    : undefined
              }
              disabled={isSaving}
            />
          </div>

          {validationError && (
            <p id={`${inputId}-error`} role="alert" className="text-sm text-destructive">
              {validationError}
            </p>
          )}

          {ignoreBudget && (
            <p
              id={`${inputId}-inactive`}
              role="status"
              className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground"
            >
              This provider threshold remains saved, but no provider thresholds are enforced while
              Ignore budget for all providers is on.
            </p>
          )}

          <Button type="submit" size="sm" disabled={isSaving || draftIsUnchanged}>
            {savingOperation === "limit" && (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            )}
            Save threshold
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
