#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <LittleFS.h>
#include <Adafruit_BME680.h>
#include <BH1750.h>
#include <time.h>
#include "secrets.h"

const int soilA = 34;
const int soilB = 35;

// Calibration 
const int dryA = 3130;
const int wetA = 1266;

const int dryB = 3160;
const int wetB = 1272;

// Sensors
Adafruit_BME680 bme;
BH1750 lightMeter;
bool bmeAvailable = false;

const char* OFFLINE_ENV_LOG = "/offline_env.log";
const char* OFFLINE_PLANT_LOG = "/offline_plant.log";
const size_t OFFLINE_QUEUE_MAX_BYTES = 500UL * 1024UL;

static_assert(
  WIFI_NETWORK_COUNT == (sizeof(WIFI_PASSWORDS) / sizeof(WIFI_PASSWORDS[0])),
  "WIFI_SSIDS and WIFI_PASSWORDS must have the same number of entries"
);

String buildEnvironmentJson(float tempC, float hum, float pressure_hPa, float gas_kOhm, float lux);
String buildPlantReadingJson(const char* plantId, int raw, float pct);
String buildReadingTimestamp();
bool systemTimeIsValid();
bool syncSystemTime(unsigned long timeoutMs = 5000);
bool postEnvironmentJson(const String& json);
bool postPlantReadingJson(const String& json);
bool appendOfflineJson(const char* path, const String& json, const char* savedMessage);
bool flushOfflineQueue(const char* path, bool (*postJson)(const String&));
bool flushOfflineQueues();

// Helper functions
int readStable(int pin) {
  long total = 0;
  for (int i = 0; i < 20; i++) {
    total += analogRead(pin);
    delay(2);
  }
  return total / 20;
}

float moisturePercent(int reading, int dry, int wet) {
  float pct = (float)(dry - reading) / (float)(dry - wet) * 100.0f;
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return pct;
}

bool systemTimeIsValid() {
  return time(nullptr) > 1700000000;
}

bool syncSystemTime(unsigned long timeoutMs) {
  if (WiFi.status() != WL_CONNECTED || systemTimeIsValid()) {
    return systemTimeIsValid();
  }

  configTime(0, 0, "pool.ntp.org", "time.nist.gov", "time.google.com");

  unsigned long start = millis();
  while (!systemTimeIsValid() && millis() - start < timeoutMs) {
    delay(100);
  }

  if (systemTimeIsValid()) {
    Serial.println("System time synchronized");
    return true;
  }

  Serial.println("WARN: time sync failed; timestamps may be inaccurate");
  return false;
}

String buildReadingTimestamp() {
  time_t now = time(nullptr);
  if (!systemTimeIsValid()) {
    return "";
  }

  struct tm timeInfo;
  gmtime_r(&now, &timeInfo);

  char buffer[25];
  strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &timeInfo);
  return String(buffer);
}

String buildEnvironmentJson(float tempC, float hum, float pressure_hPa, float gas_kOhm, float lux) {
  String timestamp = buildReadingTimestamp();
  return String("{") +
    "\"timestamp\":\"" + timestamp + "\"," +
    "\"temperature\":" + String(tempC, 2) + "," +
    "\"humidity\":" + String(hum, 2) + "," +
    "\"pressure\":" + String(pressure_hPa, 2) + "," +
    "\"gas_resistance\":" + String(gas_kOhm, 2) + "," +
    "\"light_level\":" + String(lux, 2) +
    "}";
}

String buildPlantReadingJson(const char* plantId, int raw, float pct) {
  String timestamp = buildReadingTimestamp();
  return String("{") +
    "\"timestamp\":\"" + timestamp + "\"," +
    "\"plant_id\":\"" + String(plantId) + "\"," +
    "\"soil_moisture_raw\":" + String(raw) + "," +
    "\"soil_moisture_percent\":" + String(pct, 1) +
    "}";
}

unsigned long lastReconnectAttempt = 0;
int activeWifiProfile = -1;

bool connectUsingProfile(int profileIndex, unsigned long timeoutMs = 15000) {
  Serial.print("Trying WiFi: ");
  Serial.println(WIFI_SSIDS[profileIndex]);

  WiFi.begin(WIFI_SSIDS[profileIndex], WIFI_PASSWORDS[profileIndex]);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    activeWifiProfile = profileIndex;
    Serial.println();
    Serial.print("Connected to WiFi: ");
    Serial.println(WIFI_SSIDS[profileIndex]);
    return true;
  }

  Serial.println();
  Serial.print("Failed to connect to WiFi: ");
  Serial.println(WIFI_SSIDS[profileIndex]);
  WiFi.disconnect(true);
  return false;
}

bool connectToWiFi() {
    Serial.println("Connecting to WiFi...");

  for (size_t i = 0; i < WIFI_NETWORK_COUNT; i++) {
    if (connectUsingProfile((int)i)) {
      return true;
    }
  }

  return false;
}

void checkWiFiConnection() {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("WiFi disconnected. Attempting reconnect...");

        unsigned long now = millis();

        // Try reconnect every 10 seconds
        if (now - lastReconnectAttempt > 10000) {
            lastReconnectAttempt = now;
          WiFi.disconnect(true);

          if (activeWifiProfile >= 0 && connectUsingProfile(activeWifiProfile)) {
            return;
          }

          for (size_t i = 0; i < WIFI_NETWORK_COUNT; i++) {
            if ((int)i == activeWifiProfile) {
              continue;
            }

            if (connectUsingProfile((int)i)) {
              return;
            }
          }
        }
    }
}

int supabasePost(const String& path, const String& jsonBody, String& outBody) {
  if (WiFi.status() != WL_CONNECTED) {
    outBody = "WiFi not connected";
    return -1;
  }

  for (int attempt = 0; attempt < 3; attempt++) {
    WiFiClientSecure client;
    client.setInsecure();

    HTTPClient https;
    String url = String(SUPABASE_URL) + path;

    if (!https.begin(client, url)) {
      outBody = "https.begin failed";
      return -1;
    }

    https.addHeader("apikey", SUPABASE_KEY);
    https.addHeader("Authorization", String("Bearer ") + SUPABASE_KEY);
    https.addHeader("Content-Type", "application/json");
    https.addHeader("Prefer", "return=representation");

    int code = https.POST((uint8_t*)jsonBody.c_str(), jsonBody.length());
    outBody = https.getString();
    https.end();

    if (code != -1) return code;

    delay(300);
  }

  return -1;
}

bool postEnvironmentJson(const String& json) {
  String body;
  int code = supabasePost("/rest/v1/environment_readings", json, body);
  Serial.print("POST env code: "); Serial.println(code);
  if (code < 200 || code >= 300) {
    Serial.println(body);
    return false;
  }
  return true;
}

bool postPlantReadingJson(const String& json) {
  String body;
  int code = supabasePost("/rest/v1/plant_readings", json, body);
  Serial.print("POST plant code: "); Serial.println(code);
  if (code < 200 || code >= 300) {
    Serial.println(body);
    return false;
  }
  return true;
}

bool appendOfflineJson(const char* path, const String& json, const char* savedMessage) {
  if (LittleFS.exists(path)) {
    File existing = LittleFS.open(path, FILE_READ);
    if (existing) {
      if ((size_t)existing.size() > OFFLINE_QUEUE_MAX_BYTES) {
        Serial.print("WARN: offline queue too large: ");
        Serial.println(path);
      }
      existing.close();
    }
  }

  bool createNew = !LittleFS.exists(path);
  File file = LittleFS.open(path, createNew ? FILE_WRITE : FILE_APPEND);
  if (!file) {
    Serial.print("WARN: could not open offline queue: ");
    Serial.println(path);
    return false;
  }

  if ((size_t)file.size() > OFFLINE_QUEUE_MAX_BYTES) {
    Serial.print("WARN: offline queue too large: ");
    Serial.println(path);
  }

  if (file.println(json) == 0) {
    Serial.print("WARN: could not append offline queue: ");
    Serial.println(path);
    file.close();
    return false;
  }

  file.close();
  Serial.println(savedMessage);
  return true;
}

bool flushOfflineQueue(const char* path, bool (*postJson)(const String&)) {
  if (!LittleFS.exists(path)) {
    return true;
  }

  File file = LittleFS.open(path, FILE_READ);
  if (!file) {
    Serial.print("WARN: could not open offline queue for reading: ");
    Serial.println(path);
    return false;
  }

  if ((size_t)file.size() > OFFLINE_QUEUE_MAX_BYTES) {
    Serial.print("WARN: offline queue too large: ");
    Serial.println(path);
  }

  bool allOk = true;
  while (file.available()) {
    String line = file.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) {
      continue;
    }

    if (!postJson(line)) {
      allOk = false;
      break;
    }
  }

  file.close();

  if (!allOk) {
    return false;
  }

  if (!LittleFS.remove(path)) {
    Serial.print("WARN: could not clear offline queue: ");
    Serial.println(path);
    return false;
  }

  return true;
}

bool flushOfflineQueues() {
  Serial.println("Flushing offline readings");

  bool envOk = flushOfflineQueue(OFFLINE_ENV_LOG, postEnvironmentJson);
  bool plantOk = flushOfflineQueue(OFFLINE_PLANT_LOG, postPlantReadingJson);
  bool ok = envOk && plantOk;

  if (ok) {
    Serial.println("Offline sync complete");
  } else {
    Serial.println("Offline sync failed; keeping queue");
  }

  return ok;
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  analogReadResolution(12);
  analogSetPinAttenuation(soilA, ADC_11db);
  analogSetPinAttenuation(soilB, ADC_11db);

  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS mount failed");
  }

  Wire.begin(21, 22);
  delay(100);

  if (bme.begin(0x77)) {
    bmeAvailable = true;
    Serial.println("BME680 found at 0x77");
  } else if (bme.begin(0x76)) {
    bmeAvailable = true;
    Serial.println("BME680 found at 0x76");
  } else {
    Serial.println("BME680 not found at 0x77 or 0x76. Continuing without env sensor.");
  }

  if (!lightMeter.begin()) {
    Serial.println("BH1750 not found!");
    while (1) delay(10);
  }

  if (!connectToWiFi()) {
    Serial.println("Continuing offline until WiFi reconnects");
  } else {
    syncSystemTime();
  }

  Serial.println("System ready.");
}

void loop() {
  checkWiFiConnection();

  bool wifiConnected = (WiFi.status() == WL_CONNECTED);
  if (wifiConnected) {
    syncSystemTime();
    flushOfflineQueues();
  }

  // Read soil
  int rawA = readStable(soilA);
  int rawB = readStable(soilB);
  float pctA = moisturePercent(rawA, dryA, wetA);
  float pctB = moisturePercent(rawB, dryB, wetB);

  float lux = lightMeter.readLightLevel();
  float tempC = 0.0f;
  float hum = 0.0f;
  float pressure_hPa = 0.0f;
  float gas_kOhm = 0.0f;
  bool hasEnvReading = false;

  // Read env when available.
  if (bmeAvailable) {
    if (bme.performReading()) {
      tempC = bme.temperature;
      hum = bme.humidity;
      pressure_hPa = bme.pressure / 100.0f;
      gas_kOhm = bme.gas_resistance / 1000.0f;
      hasEnvReading = true;
    } else {
      Serial.println("WARN: BME read failed this cycle");
    }
  }

  // Log locally
  Serial.println("--------------------------------------------------");
  Serial.print("A raw="); Serial.print(rawA); Serial.print(" A%="); Serial.println(pctA, 1);
  Serial.print("B raw="); Serial.print(rawB); Serial.print(" B%="); Serial.println(pctB, 1);
  if (hasEnvReading) {
    Serial.print("Temp="); Serial.print(tempC, 2);
    Serial.print("C Hum="); Serial.print(hum, 2);
    Serial.print("% Press="); Serial.print(pressure_hPa, 2);
    Serial.print("hPa Gas="); Serial.print(gas_kOhm, 2);
    Serial.print("kOhm Lux="); Serial.println(lux, 2);
  } else {
    Serial.print("Env=N/A Lux="); Serial.println(lux, 2);
  }

  String envJson = hasEnvReading ? buildEnvironmentJson(tempC, hum, pressure_hPa, gas_kOhm, lux) : "";
  String plantAJson = buildPlantReadingJson(PLANT_A_ID, rawA, pctA);
  String plantBJson = buildPlantReadingJson(PLANT_B_ID, rawB, pctB);

  bool okEnv = false;
  if (hasEnvReading) {
    if (wifiConnected) {
      okEnv = postEnvironmentJson(envJson);
      if (!okEnv) {
        appendOfflineJson(OFFLINE_ENV_LOG, envJson, "Saved env reading offline");
      }
    } else {
      appendOfflineJson(OFFLINE_ENV_LOG, envJson, "Saved env reading offline");
    }
  }

  bool okA = false;
  if (wifiConnected) {
    okA = postPlantReadingJson(plantAJson);
    if (!okA) {
      appendOfflineJson(OFFLINE_PLANT_LOG, plantAJson, "Saved plant reading offline");
    }
  } else {
    appendOfflineJson(OFFLINE_PLANT_LOG, plantAJson, "Saved plant reading offline");
  }

  bool okB = false;
  if (wifiConnected) {
    okB = postPlantReadingJson(plantBJson);
    if (!okB) {
      appendOfflineJson(OFFLINE_PLANT_LOG, plantBJson, "Saved plant reading offline");
    }
  } else {
    appendOfflineJson(OFFLINE_PLANT_LOG, plantBJson, "Saved plant reading offline");
  }

  Serial.print("Insert results -> env: ");
  Serial.print(okEnv ? "OK" : "FAIL");
  Serial.print(" | A: ");
  Serial.print(okA ? "OK" : "FAIL");
  Serial.print(" | B: ");
  Serial.println(okB ? "OK" : "FAIL");

  delay(60000); 
}