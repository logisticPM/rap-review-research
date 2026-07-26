import { test } from "node:test";
import assert from "node:assert/strict";
import { SweGoldenAdapter } from "../../src/benchmark/adapters/swe-golden-adapter.ts";
import { DatasetAdapterError } from "../../src/benchmark/benchmark-errors.ts";

const RAW = {
  name: "SWE-PRBench (sample)",
  instances: [
    {
      instance_id: "grafana-79265",
      pr_title: "Add configurable device limit",
      patch: "diff --git a/x.go b/x.go\n@@ -1 +1 @@\n-a\n+b\n",
      golden_comments: [
        { comment: "Race condition on device count check.", severity: "High" },
        { comment: "Misleading error when no rows updated.", severity: "Low" },
      ],
    },
  ],
};

test("maps location-less golden comments into a coverage dataset", () => {
  const ds = new SweGoldenAdapter().toDataset(RAW);
  assert.equal(ds.source, "swe-prbench");
  assert.equal(ds.instances.length, 1);
  const inst = ds.instances[0];
  assert.equal(inst.instanceId, "grafana-79265");
  assert.equal(inst.rawDiff, RAW.instances[0].patch);
  assert.equal(inst.goldenComments.length, 2);
  assert.equal(inst.goldenComments[0].body, "Race condition on device count check.");
  assert.equal(inst.goldenComments[0].severity, "high"); // normalized
  assert.equal(inst.goldenComments[0].id, "grafana-79265-gc-0");
});

test("throws only on a missing instances array, id, or patch — never on missing location", () => {
  assert.throws(() => new SweGoldenAdapter().toDataset({} as never), DatasetAdapterError);
  assert.throws(
    () => new SweGoldenAdapter().toDataset({ instances: [{ pr_title: "x", patch: "d" }] } as never),
    DatasetAdapterError,
  );
  assert.throws(
    () => new SweGoldenAdapter().toDataset({ instances: [{ instance_id: "i" }] } as never),
    DatasetAdapterError,
  );
  // A comment with no file/line is fine (there is no location in this benchmark).
  const ds = new SweGoldenAdapter().toDataset({
    instances: [{ instance_id: "i", patch: "d", golden_comments: [{ comment: "c" }] }],
  } as never);
  assert.equal(ds.instances[0].goldenComments[0].severity, undefined);
});
