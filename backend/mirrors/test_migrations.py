from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class PhoneMigrationTests(TransactionTestCase):
    def test_production_lineage_preserves_legacy_customers(self):
        before = [("mirrors", "0017_customer_facebook")]
        after = [("mirrors", "0020_follow_proof")]
        executor = MigrationExecutor(connection)
        try:
            executor.migrate(before)
            old = executor.loader.project_state(before).apps.get_model("mirrors", "Customer")
            old.objects.create(session="legacy-one", phone="")
            old.objects.create(session="legacy-two", phone="")
            old.objects.create(session="registered", phone="9845011111", reward="smart-watch")
            executor = MigrationExecutor(connection)
            executor.migrate(after)
            new = executor.loader.project_state(after).apps.get_model("mirrors", "Customer")
            self.assertEqual(new.objects.filter(phone__isnull=True).count(), 2)
            self.assertEqual(new.objects.get(phone="9845011111").reward, "smart-watch")
            self.assertEqual(new.objects.count(), 3)
        finally:
            MigrationExecutor(connection).migrate(after)
