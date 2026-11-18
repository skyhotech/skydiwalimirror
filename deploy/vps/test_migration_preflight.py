import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("preflight", Path(__file__).with_name("check_migration_history.py"))
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


class MigrationPreflightTests(unittest.TestCase):
    def test_identical_applied_source_passes(self):
        files = {"0001_initial": "hash", "0002_customer": "next"}
        plan = "[X]  mirrors.0001_initial\n[X]  mirrors.0002_customer\n"
        self.assertEqual(preflight.check(files, files, plan), 2)

    def test_future_production_history_blocks_older_checkout(self):
        with self.assertRaisesRegex(ValueError, "missing"):
            preflight.check({"0001_initial": "a"}, {"0001_initial": "a", "0002_live": "b"}, "[X] mirrors.0001_initial\n[X] mirrors.0002_live\n")

    def test_same_number_different_lineage_blocks(self):
        with self.assertRaisesRegex(ValueError, "0007_customer_purchase"):
            preflight.check({"0007_portable_phone_uniqueness": "a"}, {"0007_customer_purchase": "b"}, "[X] mirrors.0007_customer_purchase\n")

    def test_same_name_modified_migration_blocks(self):
        with self.assertRaisesRegex(ValueError, "content differs"):
            preflight.check({"0001_initial": "changed"}, {"0001_initial": "original"}, "[X] mirrors.0001_initial")

    def test_pending_migration_blocks_before_copy(self):
        with self.assertRaisesRegex(ValueError, "Unapplied"):
            preflight.check({"0001_initial": "a", "0002_next": "b"}, {"0001_initial": "a"}, "[X] mirrors.0001_initial\n[ ] mirrors.0002_next")

    def test_empty_or_corrupt_plan_fails_closed(self):
        for plan in ("", "database inaccessible", "[ ] mirrors.0001_initial", "[X] auth.0001_initial"):
            with self.subTest(plan=plan), self.assertRaisesRegex(ValueError, "No applied"):
                preflight.check({"0001_initial": "a"}, {"0001_initial": "a"}, plan)

    def test_manifest_hashes_only_migrations_without_importing_code(self):
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory) / "mirrors/migrations"
            folder.mkdir(parents=True)
            (folder / "0001_initial.py").write_text('raise RuntimeError("must not run")')
            (folder / "__init__.py").write_text("")
            (folder / ".env").write_text("secret")
            result = preflight.manifest(directory)
            self.assertEqual(list(result), ["0001_initial"])
            self.assertEqual(len(result["0001_initial"]), 64)


if __name__ == "__main__":
    unittest.main()
