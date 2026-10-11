#include <Arduino.h>
#include <avr/interrupt.h>
#include <stdlib.h>
#include <string.h>

// Universal IR remote - Arduino Uno firmware v06
// Protocol-agnostic architecture:
//   - RX: capture the IR envelope as RAW mark/space durations.
//   - TX: replay RAW mark/space durations at a requested carrier frequency.
// The Uno does NOT decide whether a frame is NEC, Sony, RC5, RC6, Panasonic,
// JVC, Sharp, LG, Samsung, etc. Protocol analysis belongs to the web app.
//
// Hardware:
//   D3  -> 470 ohm -> 2N2222 base (IR transmitter)
//   D6  <- LM358 output through 470 ohm (AIN0, comparator +)
//   D7  <- reference divider (AIN1, comparator -)

static const uint8_t IR_TX_PIN = 3;   // OC2B
static const uint8_t AIN0_PIN = 6;
static const uint8_t AIN1_PIN = 7;

// Envelope pulses below 100 us are treated as comparator chatter. Legitimate
// consumer IR envelope pulses are normally much longer than this.
static const uint16_t MIN_EDGE_US = 100;
// A long quiet period closes one IR frame. 30 ms keeps repeats separated while
// allowing long protocol frames to finish.
static const uint32_t FRAME_GAP_US = 30000UL;

// 520 durations = about 259 data bits for mark/space protocols, while keeping
// enough SRAM for the Uno serial stack and normal execution.
static const uint16_t MAX_TIMINGS = 520;
static uint16_t timings[MAX_TIMINGS];

static const uint8_t SERIAL_BUFFER_SIZE = 112;
static char serialBuffer[SERIAL_BUFFER_SIZE];
static uint8_t serialLength = 0;

volatile uint16_t timingCount = 0;
volatile uint16_t timingSeen = 0;
volatile uint16_t glitchCount = 0;
volatile uint32_t lastAcceptedEdgeUs = 0;
volatile uint32_t lastRawEdgeUs = 0;
volatile uint8_t lastAcceptedState = 0;
volatile bool captureActive = false;
volatile bool learnArmed = false;
volatile bool captureOverflow = false;

static uint16_t captureSequence = 0;
static uint8_t debugLevel = 1; // 0 = quiet, 1 = summaries

static bool txLoading = false;
static uint16_t txExpected = 0;
static uint16_t txLoaded = 0;
static uint32_t txCarrierHz = 38000UL;

static uint8_t comparatorState() {
  return (ACSR & _BV(ACO)) ? 1U : 0U;
}

static uint32_t atomicReadU32(volatile uint32_t *value) {
  uint8_t oldSreg = SREG;
  cli();
  uint32_t snapshot = *value;
  SREG = oldSreg;
  return snapshot;
}

static void comparatorDisable() {
  ACSR &= ~_BV(ACIE);
  ACSR |= _BV(ACI);
}

static void comparatorEnable() {
  ACSR &= ~_BV(ACIE);
  ACSR |= _BV(ACI);
  ACSR |= _BV(ACIE);
}

static void clearCaptureUnsafe() {
  timingCount = 0;
  timingSeen = 0;
  glitchCount = 0;
  captureActive = false;
  captureOverflow = false;
  uint32_t now = micros();
  lastAcceptedEdgeUs = now;
  lastRawEdgeUs = now;
  lastAcceptedState = comparatorState();
}

static void resetCapture() {
  uint8_t oldSreg = SREG;
  cli();
  clearCaptureUnsafe();
  SREG = oldSreg;
}

static void setCarrier(uint32_t frequencyHz) {
  if (frequencyHz < 30000UL) frequencyHz = 30000UL;
  if (frequencyHz > 60000UL) frequencyHz = 60000UL;

  uint32_t top = (F_CPU / (8UL * frequencyHz)) - 1UL;
  if (top < 10UL) top = 10UL;
  if (top > 255UL) top = 255UL;

  OCR2A = (uint8_t)top;
  OCR2B = (uint8_t)(top / 3UL); // about 33% duty cycle
}

static void carrierOn() {
  TCCR2A |= _BV(COM2B1);
}

static void carrierOff() {
  TCCR2A &= ~_BV(COM2B1);
  digitalWrite(IR_TX_PIN, LOW);
}

static void markUs(uint16_t durationUs) {
  carrierOn();
  delayMicroseconds(durationUs);
}

static void spaceUs(uint16_t durationUs) {
  carrierOff();
  delayMicroseconds(durationUs);
}

static bool parseUnsigned(const char *text, uint32_t &value, uint8_t base = 10) {
  if (!text || !*text) return false;
  char *endPtr = nullptr;
  unsigned long parsed = strtoul(text, &endPtr, base);
  if (*endPtr != '\0') return false;
  value = parsed;
  return true;
}

static void printStatus(const __FlashStringHelper *tag) {
  if (debugLevel == 0) return;
  Serial.print(F("DBG STATUS tag="));
  Serial.print(tag);
  Serial.print(F(" armed="));
  Serial.print(learnArmed ? 1 : 0);
  Serial.print(F(" active="));
  Serial.print(captureActive ? 1 : 0);
  Serial.print(F(" aco="));
  Serial.print(comparatorState());
  Serial.print(F(" count="));
  Serial.print(timingSeen);
  Serial.print(F(" glitches="));
  Serial.println(glitchCount);
}

static void commandLearn() {
  comparatorDisable();
  learnArmed = false;
  resetCapture();
  learnArmed = true;
  comparatorEnable();
  Serial.println(F("ARMED RAW"));
  printStatus(F("ARM"));
}

static void commandCancel() {
  learnArmed = false;
  comparatorDisable();
  resetCapture();
  Serial.println(F("CANCELLED"));
}

static void commandDebug(char *savePtr) {
  char *token = strtok_r(nullptr, " ", &savePtr);
  uint32_t value = 0;
  if (!parseUnsigned(token, value) || value > 1) {
    Serial.println(F("ERR DEBUG_ARG"));
    return;
  }
  debugLevel = (uint8_t)value;
  Serial.print(F("DEBUG "));
  Serial.println(debugLevel);
}

static void commandTxRawBegin(char *savePtr) {
  uint32_t carrier = 0;
  uint32_t count = 0;
  char *carrierText = strtok_r(nullptr, " ", &savePtr);
  char *countText = strtok_r(nullptr, " ", &savePtr);
  if (!parseUnsigned(carrierText, carrier) || !parseUnsigned(countText, count) ||
      carrier < 30000UL || carrier > 60000UL || count < 1 || count > MAX_TIMINGS) {
    Serial.println(F("ERR TXRAW_BEGIN"));
    return;
  }

  comparatorDisable();
  learnArmed = false;
  resetCapture();

  txCarrierHz = carrier;
  txExpected = (uint16_t)count;
  txLoaded = 0;
  txLoading = true;
  Serial.print(F("TXRAW READY "));
  Serial.println(txExpected);
}

static void commandTxRawData(char *savePtr) {
  if (!txLoading) {
    Serial.println(F("ERR TXRAW_NOT_STARTED"));
    return;
  }

  uint32_t offset = 0;
  char *offsetText = strtok_r(nullptr, " ", &savePtr);
  if (!parseUnsigned(offsetText, offset) || offset != txLoaded) {
    Serial.println(F("ERR TXRAW_OFFSET"));
    return;
  }

  uint16_t added = 0;
  while (true) {
    char *token = strtok_r(nullptr, " ", &savePtr);
    if (!token) break;
    uint32_t duration = 0;
    if (!parseUnsigned(token, duration) || duration < 1 || duration > 65535UL || txLoaded >= txExpected) {
      Serial.println(F("ERR TXRAW_DATA"));
      txLoading = false;
      return;
    }
    timings[txLoaded++] = (uint16_t)duration;
    ++added;
  }

  if (added == 0) {
    Serial.println(F("ERR TXRAW_EMPTY"));
    return;
  }

  Serial.print(F("TXRAW LOADED "));
  Serial.println(txLoaded);
}

static void commandTxRawGo() {
  if (!txLoading || txLoaded != txExpected) {
    Serial.print(F("ERR TXRAW_INCOMPLETE "));
    Serial.print(txLoaded);
    Serial.print(' ');
    Serial.println(txExpected);
    return;
  }

  txLoading = false;
  setCarrier(txCarrierHz);

  // Consumer IR frames begin with a modulated burst (MARK), then alternate.
  for (uint16_t i = 0; i < txExpected; ++i) {
    if ((i & 1U) == 0) markUs(timings[i]);
    else spaceUs(timings[i]);
  }
  carrierOff();
  Serial.println(F("TXOK"));
}

static void processCommand(char *line) {
  char *savePtr = nullptr;
  char *command = strtok_r(line, " ", &savePtr);
  if (!command) return;

  if (strcmp(command, "PING") == 0) {
    Serial.println(F("PONG UNO_IR_6 RAW"));
  } else if (strcmp(command, "LEARN") == 0) {
    commandLearn();
  } else if (strcmp(command, "CANCEL") == 0) {
    commandCancel();
  } else if (strcmp(command, "STATUS") == 0) {
    printStatus(F("HOST"));
  } else if (strcmp(command, "DEBUG") == 0) {
    commandDebug(savePtr);
  } else if (strcmp(command, "TXRAW_BEGIN") == 0) {
    commandTxRawBegin(savePtr);
  } else if (strcmp(command, "TXRAW_DATA") == 0) {
    commandTxRawData(savePtr);
  } else if (strcmp(command, "TXRAW_GO") == 0) {
    commandTxRawGo();
  } else {
    Serial.println(F("ERR UNKNOWN_CMD"));
  }
}

static void serviceSerial() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\r') continue;

    if (c == '\n') {
      serialBuffer[serialLength] = '\0';
      if (serialLength > 0) processCommand(serialBuffer);
      serialLength = 0;
      continue;
    }

    if (serialLength < SERIAL_BUFFER_SIZE - 1) {
      serialBuffer[serialLength++] = c;
    } else {
      serialLength = 0;
      Serial.println(F("ERR LINE_TOO_LONG"));
    }
  }
}

static void printCapturedFrame(uint16_t id,
                               uint16_t count,
                               uint16_t seen,
                               uint16_t glitches,
                               bool overflow) {
  uint32_t totalUs = 0;
  uint16_t minUs = 65535U;
  uint16_t maxUs = 0;
  for (uint16_t i = 0; i < count; ++i) {
    uint16_t value = timings[i];
    totalUs += value;
    if (value < minUs) minUs = value;
    if (value > maxUs) maxUs = value;
  }

  if (debugLevel) {
    Serial.print(F("DBG CAP id="));
    Serial.print(id);
    Serial.print(F(" stored="));
    Serial.print(count);
    Serial.print(F(" seen="));
    Serial.print(seen);
    Serial.print(F(" glitches="));
    Serial.print(glitches);
    Serial.print(F(" overflow="));
    Serial.print(overflow ? 1 : 0);
    Serial.print(F(" totalUs="));
    Serial.print(totalUs);
    Serial.print(F(" min="));
    Serial.print(count ? minUs : 0);
    Serial.print(F(" max="));
    Serial.println(maxUs);
  }

  Serial.print(F("RXBEGIN "));
  Serial.print(id);
  Serial.print(' ');
  Serial.print(count);
  Serial.print(' ');
  Serial.print(glitches);
  Serial.print(' ');
  Serial.println(overflow ? 1 : 0);

  const uint8_t chunkSize = 14;
  for (uint16_t base = 0; base < count; base += chunkSize) {
    Serial.print(F("RXDATA "));
    Serial.print(id);
    Serial.print(' ');
    Serial.print(base);
    uint16_t end = base + chunkSize;
    if (end > count) end = count;
    for (uint16_t i = base; i < end; ++i) {
      Serial.print(' ');
      Serial.print(timings[i]);
    }
    Serial.println();
  }

  Serial.print(F("RXEND "));
  Serial.println(id);
}

static void serviceReceiver() {
  if (!learnArmed || !captureActive) return;

  uint32_t lastEdge = atomicReadU32(&lastRawEdgeUs);
  uint32_t now = micros();
  if ((uint32_t)(now - lastEdge) <= FRAME_GAP_US) return;

  comparatorDisable();

  // Re-check after freezing the comparator. This prevents a race if an edge
  // arrived just before interrupts were disabled.
  lastEdge = atomicReadU32(&lastRawEdgeUs);
  now = micros();
  if ((uint32_t)(now - lastEdge) <= FRAME_GAP_US) {
    comparatorEnable();
    return;
  }

  uint16_t count = timingCount;
  uint16_t seen = timingSeen;
  uint16_t glitches = glitchCount;
  bool overflow = captureOverflow;
  captureActive = false;

  // Ignore tiny noise captures and keep listening. A real remote frame or a
  // repeat code has at least a few meaningful envelope durations.
  if (seen < 3) {
    resetCapture();
    if (learnArmed) comparatorEnable();
    return;
  }

  uint16_t id = ++captureSequence;
  printCapturedFrame(id, count, seen, glitches, overflow);

  // One captured frame completes one LEARN request. The browser decides whether
  // it is valid, repeated, recognizable, or needs another acquisition.
  learnArmed = false;
  resetCapture();
}

ISR(ANALOG_COMP_vect) {
  if (!learnArmed) return;

  uint32_t now = micros();

  if (!captureActive) {
    captureActive = true;
    timingCount = 0;
    timingSeen = 0;
    glitchCount = 0;
    captureOverflow = false;
    lastAcceptedEdgeUs = now;
    lastRawEdgeUs = now;
    lastAcceptedState = comparatorState();
    return;
  }

  uint32_t rawDelta = now - lastRawEdgeUs;
  lastRawEdgeUs = now;

  // If loop() did not close a previous frame in time, restart rather than merge
  // two independent remote frames.
  if (rawDelta > FRAME_GAP_US) {
    timingCount = 0;
    timingSeen = 0;
    glitchCount = 0;
    captureOverflow = false;
    lastAcceptedEdgeUs = now;
    lastAcceptedState = comparatorState();
    return;
  }

  const uint8_t currentState = comparatorState();
  // If ignored chatter toggled back to the already accepted comparator state,
  // this is not a new logical envelope edge. Ignoring it prevents a train of
  // 12/16/20 us chatter from accumulating into fake 100/104/108 us timings.
  if (currentState == lastAcceptedState) {
    if (glitchCount < 65535U) ++glitchCount;
    return;
  }

  uint32_t acceptedDelta = now - lastAcceptedEdgeUs;
  if (acceptedDelta < MIN_EDGE_US) {
    if (glitchCount < 65535U) ++glitchCount;
    return;
  }

  lastAcceptedEdgeUs = now;
  lastAcceptedState = currentState;
  if (timingSeen < 65535U) ++timingSeen;

  if (timingCount < MAX_TIMINGS) {
    timings[timingCount++] = acceptedDelta > 65535UL ? 65535U : (uint16_t)acceptedDelta;
  } else {
    captureOverflow = true;
  }
}

void setup() {
  pinMode(IR_TX_PIN, OUTPUT);
  digitalWrite(IR_TX_PIN, LOW);
  pinMode(AIN0_PIN, INPUT);
  pinMode(AIN1_PIN, INPUT);

  Serial.begin(115200);

  // Timer2 Fast PWM, TOP=OCR2A, OC2B on D3.
  TCCR2A = _BV(WGM20) | _BV(WGM21);
  TCCR2B = _BV(WGM22) | _BV(CS21);
  setCarrier(38000UL);
  carrierOff();

  // Analog comparator D6/AIN0 (+) vs D7/AIN1 (-), interrupt on toggle.
  DIDR1 |= _BV(AIN0D) | _BV(AIN1D);
  ACSR = _BV(ACI); // comparator active, interrupt disabled until LEARN

  resetCapture();
  Serial.println(F("READY UNO_IR_6 RAW"));
  printStatus(F("BOOT"));
}

void loop() {
  serviceSerial();
  serviceReceiver();
}
