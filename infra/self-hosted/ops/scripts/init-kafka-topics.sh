#!/bin/sh
# Creates the event topics that do not exist yet. Runs in the Kafka image,
# which has the admin tool. The list is the repository's generated one
# (.github/kafka-cluster-topics.json, from macro_event_topics), copied into
# the image; six partitions as on the local stack, one replica for one broker.
set -eu

topics=/supamac/config/kafka/topics.json
bootstrap=${KAFKA_BROKERS:-kafka:9092}
admin=/opt/kafka/bin/kafka-topics.sh

# Listed once: the admin tool is a JVM, and a deployment that has nothing to
# create should start it once, not once per topic.
existing=$("$admin" --bootstrap-server "$bootstrap" --list)

# The file is a JSON array of names without spaces, commas or escapes. A comma
# ends a name however the array is laid out.
tr ',' '\n' < "$topics" | tr -d '[]" \t' | grep . | while read -r topic; do
  if printf '%s\n' "$existing" | grep -qxF "$topic"; then
    continue
  fi

  "$admin" --bootstrap-server "$bootstrap" \
    --create --if-not-exists --topic "$topic" --partitions 6 --replication-factor 1
done
