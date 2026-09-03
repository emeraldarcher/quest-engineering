<script lang="ts">
import type { RealtimeStatus } from "../../realtime/client";

export let status: RealtimeStatus;
export let serverReachable: boolean | null = null;

$: healthy = status === "connected" || serverReachable === true;
$: updatesDelayed = serverReachable === true && status !== "connected";
$: label = healthy
  ? "Online"
  : status === "connecting"
    ? "Connecting"
    : status === "reconnecting"
      ? "Reconnecting"
      : "Disconnected";
$: updateStatus = status === "connecting" ? "connecting" : "reconnecting";
$: accessibleLabel = updatesDelayed
  ? `Quest Engineering server connected; live updates ${updateStatus}`
  : healthy
    ? "Quest Engineering server connected"
    : `Quest Engineering server ${label.toLocaleLowerCase()}`;
</script>

<span class="connection" class:healthy class:updates-delayed={updatesDelayed} class:unhealthy={!healthy} title={accessibleLabel}>
  <span class="connection-dot" aria-hidden="true"></span>
  <span class="connection-label" aria-hidden="true">{label}</span>
  <span class="sr-only">{accessibleLabel}</span>
</span>

<style>
.connection { display:flex; align-items:center; gap:.38rem; padding-left:.8rem; color:#f5d8a2; font-size:.75rem; font-weight:780; white-space:nowrap; }
.connection-dot { width:.48rem; height:.48rem; background:#d19a52; border:1px solid #f5ddb2; border-radius:50%; box-shadow:0 0 0 2px #241813; }
.connection.healthy { color:#d4ead1; }
.healthy .connection-dot { background:#78b477; }
.connection.updates-delayed .connection-dot { border-color:#e7c77f; }
.connection.unhealthy { color:#ffd09b; font-weight:850; }
.unhealthy .connection-dot { background:#d36b57; }
.sr-only { position:absolute; width:1px; height:1px; padding:0; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
@media(max-width:560px){.connection-label{display:none}.connection{padding-left:.35rem}}
</style>
