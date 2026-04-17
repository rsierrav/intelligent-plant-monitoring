#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Adafruit_BME680.h>
#include <BH1750.h>
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

unsigned long lastReconnectAttempt = 0;

void connectToWiFi() {
    Serial.println("Connecting to WiFi...");
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void checkWiFiConnection() {
    if (WiFi.status() != WL_CONNECTED) {
        Serial.println("WiFi disconnected. Attempting reconnect...");

        unsigned long now = millis();

        // Try reconnect every 10 seconds
        if (now - lastReconnectAttempt > 10000) {
            lastReconnectAttempt = now;
            WiFi.disconnect();
            WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
        }
    }
}

int supabasePost(const String& path, const String& jsonBody, String& outBody) {
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

bool postEnvironment(float tempC, float hum, float pressure_hPa, float gas_kOhm, float lux) {
  String json =
    String("{") +
    "\"temperature\":" + String(tempC, 2) + "," +
    "\"humidity\":" + String(hum, 2) + "," +
    "\"pressure\":" + String(pressure_hPa, 2) + "," +
    "\"gas_resistance\":" + String(gas_kOhm, 2) + "," +
    "\"light_level\":" + String(lux, 2) +
    "}";

  String body;
  int code = supabasePost("/rest/v1/environment_readings", json, body);
  Serial.print("POST env code: "); Serial.println(code);
  if (code < 200 || code >= 300) {
    Serial.println(body);
    return false;
  }
  return true;
}

bool postPlantReading(const char* plantId, int raw, float pct) {
  // Assumes columns exist:
  // soil_moisture_raw (int), soil_moisture_percent (float)
  String json =
    String("{") +
    "\"plant_id\":\"" + String(plantId) + "\"," +
    "\"soil_moisture_raw\":" + String(raw) + "," +
    "\"soil_moisture_percent\":" + String(pct, 1) +
    "}";

  String body;
  int code = supabasePost("/rest/v1/plant_readings", json, body);
  Serial.print("POST plant code: "); Serial.println(code);
  if (code < 200 || code >= 300) {
    Serial.println(body);
    return false;
  }
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  analogReadResolution(12);
  analogSetPinAttenuation(soilA, ADC_11db);
  analogSetPinAttenuation(soilB, ADC_11db);

  Wire.begin(21, 22);

  if (!bme.begin(0x77)) {
    Serial.println("BME680 not found!");
    while (1) delay(10);
  }

  if (!lightMeter.begin()) {
    Serial.println("BH1750 not found!");
    while (1) delay(10);
  }

  connectToWiFi();
  // Wait for first connection
  while (WiFi.status() != WL_CONNECTED) {
      delay(500);
      Serial.print(".");
  }

  Serial.println("System ready.");
}

void loop() {
  checkWiFiConnection();
  
   // Read soil
  int rawA = readStable(soilA);
  int rawB = readStable(soilB);
  float pctA = moisturePercent(rawA, dryA, wetA);
  float pctB = moisturePercent(rawB, dryB, wetB);

  // Read env
  if (!bme.performReading()) {
    Serial.println("ERROR: BME read failed");
    delay(5000);
    return;
  }

  float lux = lightMeter.readLightLevel();
  float tempC = bme.temperature;
  float hum = bme.humidity;
  float pressure_hPa = bme.pressure / 100.0f;
  float gas_kOhm = bme.gas_resistance / 1000.0f;

  // Log locally
  Serial.println("--------------------------------------------------");
  Serial.print("A raw="); Serial.print(rawA); Serial.print(" A%="); Serial.println(pctA, 1);
  Serial.print("B raw="); Serial.print(rawB); Serial.print(" B%="); Serial.println(pctB, 1);
  Serial.print("Temp="); Serial.print(tempC, 2);
  Serial.print("C Hum="); Serial.print(hum, 2);
  Serial.print("% Press="); Serial.print(pressure_hPa, 2);
  Serial.print("hPa Gas="); Serial.print(gas_kOhm, 2);
  Serial.print("kOhm Lux="); Serial.println(lux, 2);

  // Cloud inserts
  bool okEnv = postEnvironment(tempC, hum, pressure_hPa, gas_kOhm, lux);
  bool okA = postPlantReading(PLANT_A_ID, rawA, pctA);
  bool okB = postPlantReading(PLANT_B_ID, rawB, pctB);

  Serial.print("Insert results -> env: ");
  Serial.print(okEnv ? "OK" : "FAIL");
  Serial.print(" | A: ");
  Serial.print(okA ? "OK" : "FAIL");
  Serial.print(" | B: ");
  Serial.println(okB ? "OK" : "FAIL");

  delay(60000); 
}