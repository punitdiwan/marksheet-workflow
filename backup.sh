#!/bin/bash
set -e

# ========= DATABASE CONFIG =========
export PGPASSWORD="12DVqdXxtLLhKtr0"
export DO_ACCESS_KEY="DO00Z6BQLU76298YFU2G"
export DO_SECRET_KEY="l3XB9ck+U9tvwixHGxMopTFVWSJlwxxpOlNJhvlQhIo"


HOST="aws-1-ap-south-1.pooler.supabase.com"
PORT="6543"
USER="postgres.ivmgtyrntujlbrjiryna"
DB="postgres"

# ========= DIGITALOCEAN SPACES CONFIG =========
BUCKET_NAME="YOUR_BUCKET_NAME"
SPACES_ENDPOINT="https://ap-south-1.digitaloceanspaces.com"

# ========= LOCAL BACKUP DIR =========
BACKUP_DIR="backup"
mkdir -p "$BACKUP_DIR"

echo "🚀 Backup started..."

# ========= GET ORGANIZATIONS =========
psql -h $HOST -p $PORT -U $USER -d $DB -t -A \
-c "SELECT id || '|' || name FROM public.organization;" |
while IFS="|" read -r ORG_ID ORG_NAME
do
  SAFE_NAME=$(echo "$ORG_NAME" | tr ' ' '_' | tr -cd '[:alnum:]_')
  ORG_DIR="$BACKUP_DIR/$SAFE_NAME"
  mkdir -p "$ORG_DIR"

  echo "📦 Backing up organization: $ORG_NAME"

  HAS_DATA=false

  # ========= GET ALL TABLES =========
  psql -h $HOST -p $PORT -U $USER -d $DB -t -A \
  -c "SELECT tablename FROM pg_tables WHERE schemaname='public';" |
  while read -r TABLE
  do
    # ===== CHECK hospital_id COLUMN =====
    HAS_COLUMN=$(psql -h $HOST -p $PORT -U $USER -d $DB -t -A \
      -c "
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema='public'
          AND table_name='$TABLE'
          AND column_name='hospital_id'
        LIMIT 1;
      ")

    if [ "$HAS_COLUMN" != "1" ]; then
      echo "  ⏭️ Skipping $TABLE (no hospital_id)"
      continue
    fi

    # ===== COUNT ROWS =====
    ROW_COUNT=$(psql -h $HOST -p $PORT -U $USER -d $DB -t -A \
      -c "SELECT COUNT(*) FROM public.\"$TABLE\" WHERE hospital_id = '$ORG_ID';")

    if [ "$ROW_COUNT" -gt 0 ]; then
      HAS_DATA=true
      echo "  ✅ Exporting $TABLE ($ROW_COUNT rows)"

      psql -h $HOST -p $PORT -U $USER -d $DB \
      -c "\copy (
            SELECT * FROM public.\"$TABLE\"
            WHERE hospital_id = '$ORG_ID'
          ) TO '$ORG_DIR/$TABLE.csv' WITH (FORMAT csv, HEADER);"
    else
      echo "  ⏭️ Skipping $TABLE (no data)"
    fi
  done




CSV_COUNT=$(find "$ORG_DIR" -maxdepth 1 -type f -name "*.csv" | wc -l)

if [ "$CSV_COUNT" -gt 0 ]; then
  TIMESTAMP=$(date +%Y-%m-%d)
  ZIP_FILE="$BACKUP_DIR/${SAFE_NAME}_${TIMESTAMP}.zip"

  echo "📦 Creating ZIP without backup folder"

  (
    cd "$BACKUP_DIR" || exit
    zip -r "$(basename "$ZIP_FILE")" "$SAFE_NAME" >/dev/null
  )

  echo "✅ ZIP created: $ZIP_FILE"

  # ========= UPLOAD TO DIGITALOCEAN SPACES =========
  echo "☁️ Uploading ZIP to DigitalOcean Spaces"

  spaces-cli up \
    -s schoolerp-bucket \
    -r blr1 \
    -i "$DO_ACCESS_KEY" \
    -k "$DO_SECRET_KEY" \
    -t "medisparsh/${SAFE_NAME}/${TIMESTAMP}" \
    "$ZIP_FILE"

  echo "✅ Upload completed:"
  echo "medisparsh/${SAFE_NAME}/${TIMESTAMP}/$(basename "$ZIP_FILE")"

else
  echo "⏭️ No CSV files found — skipping ZIP & upload"
fi


done

echo "🎉 All organization backups completed successfully!"
