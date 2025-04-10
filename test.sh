config_file="postgrest.conf"

# Extract the schema names from the config file
de_schema=$(grep -oP 'db-schema\s*=\s*"\K[^"]+' "$config_file")
del_schema="rehan"

# Convert the extracted comma-separated list into a JSON array
array=$(echo "$de_schema" | sed 's/,/","/g' | sed 's/^/["/' | sed 's/$/"]/')

# Remove the del_schema ("zeeshan") from the array using jq
filtered_array=$(echo "$array" | jq --arg del_schema "$del_schema" '[.[] | select(. != $del_schema)]')

# Print the filtered array
echo "Filtered array: $filtered_array"

append=""

for item in $(echo "$filtered_array" | jq -r '.[]'); do
    echo "$item"
    append="${append},${item}"
done
echo "$append"

str=$append

# Remove the leading comma, if it exists
cleaned_str=$(echo "$str" | sed 's/^,//')

echo "db-schema = \"$cleaned_str\"" > "$config_file"
