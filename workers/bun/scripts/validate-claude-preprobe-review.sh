#!/usr/bin/env bash
# Reviewed explicit native-Claude/provider-free allowlist. Never use `bun test`
# without paths here. See docs/claude-preprobe-review-validation.md.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
output="${QE_PREPROBE_REVIEW_OUTPUT:-$(mktemp -d /tmp/qe-preprobe-review.XXXXXX)}"
mkdir -p "$output/wire" "$output/baseline"
export QE_PREPROBE_WIRE_DIR="$output/wire"
export QE_PREPROBE_BASELINE_DIR="$output/baseline"
printf 'Validation artifacts: %s\n' "$output"
# Dedicated test database only. Background services are disabled in test.exs;
# this tag never starts WorkerConnections or delivers external commands.
env -u DATABASE_URL -u PHX_SERVER -u PORT \
  MIX_ENV=test POSTGRES_HOST=localhost POSTGRES_PORT=5432 \
  POSTGRES_USER=postgres POSTGRES_PASSWORD=postgres \
  POSTGRES_TEST_DB=quest_engineering_preprobe_review_test \
  QE_MAX_OPERATIONAL_ATTEMPTS_PER_EPOCH=2 \
  mix test apps/quest_engineering_server/test/quest_engineering_server/launch_scheduling_test.exs \
  --only preprobe_product_wire | tee "$output/product.log"

cd workers/bun
files=(
  ./test/claude-queued-probe-cancellation.test.ts
  ./test/claude-preprobe-capabilities.test.ts
  ./test/claude-code-adapter.test.ts
  ./test/claude-product-preprobe-wire.test.ts
  ./test/streamed-process.test.ts
  ./test/streamed-process-io.test.ts
  ./test/harness-lifecycle-diagnostics.test.ts
  ./test/claude-output-census-schema.test.ts
  ./test/claude-output-structure.test.ts
  ./test/claude-output-tags.test.ts
  ./test/claude-code-protocol.test.ts
  ./test/claude-protocol-schema-audit.test.ts
  ./test/claude-queued-started-source.test.ts
  ./test/queued-diagnostic-transport.test.ts
)
printf '%s\n' "${files[@]}" > "$output/allowlist.txt"
# Exclude the Python-interpreter helper test as well; AST-only relay audit below.
bun test --preload ./test/support/preprobe-no-native.ts \
  --test-name-pattern '^(?!guest diagnostic function)' "${files[@]}" 2>&1 | tee "$output/worker.log"
# Original five safe PR #59 generation/canonical/Worker-lifecycle adversarial
# regressions. This is a subset of the aggregate, not five extra unique tests.
bun test --preload ./test/support/preprobe-no-native.ts \
  --test-name-pattern '^(review: generation handoff |review: canonical cancellation |review: actual Worker disconnect/supersession)' \
  ./test/claude-code-adapter.test.ts ./test/queued-diagnostic-transport.test.ts \
  2>&1 | tee "$output/pr59-adversarial.log"
# Separately identified five review-fix adversarial tests; subset, not added
# twice to the aggregate clean total.
bun test --preload ./test/support/preprobe-no-native.ts \
  --test-name-pattern '^review-fix adversarial:' \
  ./test/claude-code-adapter.test.ts 2>&1 | tee "$output/adversarial.log"
bun run typecheck 2>&1 | tee "$output/typecheck.log"
bun run check 2>&1 | tee "$output/biome.log"
for path in src/harnesses/claude-code/{adapter,effort-readiness,protocol}.ts; do
  git show "8b71616dec57ca67a4749ac9e8b9cab6f93871f0:workers/bun/$path" > "$output/baseline/${path//\//_}"
done
bun run scripts/audit-claude-preprobe-review.ts | tee "$output/static.log"
cd "$root"
git diff --check
mix format --check-formatted apps/quest_engineering_server/test/quest_engineering_server/launch_scheduling_test.exs
# Exact-source fences: no relay/helper, timeout capability, profile/pin/settings,
# Mod, parser/census or CLI effort-readiness changes from the production baseline.
git diff --exit-code 8b71616dec57ca67a4749ac9e8b9cab6f93871f0 -- \
  workers/bun/src/execution-environment/sbx-streamed-process-relay.py \
  workers/bun/src/harnesses/claude-code/queued-probe-cancellation.ts \
  workers/bun/src/harnesses/claude-code/effort-readiness.ts \
  workers/bun/src/harnesses/claude-code/output-census.ts \
  workers/bun/src/harnesses/claude-code/output-tags.ts workers/bun/profiles
python3 - <<'PY' | tee "$output/relay-static.log"
import ast, hashlib
from pathlib import Path
p = Path('workers/bun/src/execution-environment/sbx-streamed-process-relay.py')
b = p.read_bytes()
tree = ast.parse(b, filename=str(p))
assert any(isinstance(n, ast.FunctionDef) and n.name == 'try_write_diagnostic' for n in tree.body)
print('PASS: Python relay AST parse only; no helper/main/Popen executed; SHA-256', hashlib.sha256(b).hexdigest())
PY
printf '\nPASS: allowlisted validation completed. Artifacts: %s\n' "$output"
