from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("mirrors", "0021_share_proofs")]

    operations = [
        migrations.CreateModel(
            name="InvoiceSubmission",
            fields=[
                ("filename_key", models.CharField(max_length=64, primary_key=True, serialize=False)),
            ],
        ),
    ]
