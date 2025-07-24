#!/bin/bash

export PGPASSWORD="$1"
DB_NAME="$2"
DB_USER="$3"
DB_HOST="$4"

SCHEMA="$5"
PROJECT_NAME="$6"



# Run SQL and store result into array
mapfile -t TABLES < <(
  psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -t -A -c \
  "SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = '${SCHEMA}' AND column_name = 'project_name';"
)


PROJECT_DIR="./${PROJECT_NAME}_backup"
mkdir -p "$PROJECT_DIR"

for TABLE in "${TABLES[@]}"; do
    FILE="${PROJECT_DIR}/${PROJECT_NAME}_${TABLE}.csv"
    echo "Exporting ${TABLE} for ${PROJECT_NAME} -> ${FILE}"
  
  psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -c "\COPY (SELECT * FROM ${SCHEMA}.${TABLE} WHERE project_name = '${PROJECT_NAME}') TO '${FILE}' WITH CSV HEADER"
done


# Create zip archive of the folder
ZIP_FILE="${PROJECT_NAME}_backup.zip"
zip -r "$ZIP_FILE" "$PROJECT_DIR"

echo "✅ All CSV files exported and zipped: $ZIP_FILE"