import { desktopFeatures, useFeatureToggle } from "@/shared/features";
import { useEffect, useState } from "react";
import type { FeatureDefinition } from "@/shared/features";
import { listManagedAgents } from "@/shared/api/tauri";
import {
  startManagedAgent,
  stopManagedAgent,
} from "@/shared/api/tauriManagedAgents";
import { invokeTauri } from "@/shared/api/tauri";
import { Switch } from "@/shared/ui/switch";
import { SettingsSectionHeader } from "./SettingsSectionHeader";
import { applyAcpTopLevelSessionsExperiment } from "./acpTopLevelSessionsExperiment";

function FeatureRow({ feature }: { feature: FeatureDefinition }) {
  const [enabled, toggle] = useFeatureToggle(feature.id);
  const [pending, setPending] = useState(false);
  const switchId = `feature-toggle-${feature.id}`;

  // Rust persistence is authoritative for this runtime experiment. Hydrate the
  // local feature store when the row mounts rather than pushing localStorage
  // into Tauri after launch-time agent restore has already run. Keep the switch
  // disabled until this one-shot hydration finishes so a stale local value
  // cannot race an in-flight toggle.
  const isAcpTopLevelSessions = feature.id === "acpTopLevelSessions";
  const [hydrated, setHydrated] = useState(!isAcpTopLevelSessions);
  useEffect(() => {
    if (!isAcpTopLevelSessions) return;
    let cancelled = false;
    void invokeTauri<boolean>("get_acp_top_level_sessions_experiment")
      .then((persisted) => {
        if (cancelled) return;
        toggle(persisted);
        setHydrated(true);
      })
      .catch((error) => {
        if (!cancelled) {
          console.error(
            "Failed to hydrate ACP top-level sessions experiment",
            error,
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isAcpTopLevelSessions, toggle]);

  const handleToggle = async (value: boolean) => {
    if (feature.id !== "acpTopLevelSessions") {
      toggle(value);
      return;
    }
    setPending(true);
    try {
      await applyAcpTopLevelSessionsExperiment(enabled, value, {
        setBackend: (next) =>
          invokeTauri("set_acp_top_level_sessions_experiment", {
            enabled: next,
          }),
        listAgents: listManagedAgents,
        stopAgent: stopManagedAgent,
        startAgent: startManagedAgent,
        setUi: toggle,
      });
    } catch (error) {
      console.error("Failed to apply ACP top-level sessions experiment", error);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-background/70 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium" id={`${switchId}-label`}>
          {feature.name}
        </p>
        <p className="text-xs text-muted-foreground">{feature.description}</p>
      </div>
      <Switch
        aria-labelledby={`${switchId}-label`}
        checked={enabled}
        data-testid={switchId}
        disabled={pending || !hydrated}
        onCheckedChange={(value) => void handleToggle(value)}
      />
    </div>
  );
}

export function ExperimentalFeaturesCard() {
  // Manifest is preview-only by definition; every desktop entry is a preview
  // feature.
  const previewFeatures = desktopFeatures;

  return (
    <section className="min-w-0" data-testid="settings-experimental">
      <SettingsSectionHeader
        title="Experiments"
        description={
          <>
            These features are functional but still being refined. Enable them
            to try new capabilities early.
          </>
        }
      />

      <div className="flex flex-col gap-2">
        {previewFeatures.map((f) => (
          <FeatureRow feature={f} key={f.id} />
        ))}
      </div>
    </section>
  );
}
