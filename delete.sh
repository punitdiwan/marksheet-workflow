#!/bin/bash

export PGPASSWORD="12DVqdXxtLLhKtr0"

HOST="aws-1-ap-south-1.pooler.supabase.com"
PORT="6543"
USER="postgres.ivmgtyrntujlbrjiryna"
DB="postgres"
HOSPITAL_ID="XVeNOXOH6znV3vdz8R5SytTxcaKdcDgF"

# Disable triggers (temporarily ignore FKs)
psql -h $HOST -p $PORT -U $USER -d $DB -c "SET session_replication_role = replica;"

# Loop through all tables
psql -h $HOST -p $PORT -U $USER -d $DB -t -A \
-c "SELECT tablename FROM pg_tables WHERE schemaname='public';" |
while read -r TABLE
do
    HAS_COLUMN=$(psql -h $HOST -p $PORT -U $USER -d $DB -t -A \
      -c "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='$TABLE' AND column_name='hospital_id' LIMIT 1;")
    
    if [ "$HAS_COLUMN" = "1" ]; then
        echo "🗑️ Deleting rows from $TABLE for hospital_id=$HOSPITAL_ID"
        psql -h $HOST -p $PORT -U $USER -d $DB \
        -c "DELETE FROM public.\"$TABLE\" WHERE hospital_id = '$HOSPITAL_ID';"
    else
        echo "⏭️ Skipping $TABLE (no hospital_id)"
    fi
done

# Re-enable triggers
psql -h $HOST -p $PORT -U $USER -d $DB -c "SET session_replication_role = DEFAULT;"
