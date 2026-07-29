"use client";

import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useActionData } from "@/hooks/useActionData";

export function useFitbitFeatureStatus() {
  return useActionData(useAction(api.fitbit.connections.getFitbitFeatureStatus));
}
