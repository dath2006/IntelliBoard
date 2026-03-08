/**
 * Arduino Example Projects
 *
 * Collection of example projects that users can load and run
 */

export interface ExampleProject {
  id: string;
  title: string;
  description: string;
  category: 'basics' | 'sensors' | 'displays' | 'communication' | 'games' | 'robotics';
  difficulty: 'beginner' | 'intermediate' | 'advanced';
  /** Target board — defaults to 'arduino-uno' if omitted */
  boardType?: 'arduino-uno' | 'arduino-nano' | 'raspberry-pi-pico';
  code: string;
  components: Array<{
    type: string;
    id: string;
    x: number;
    y: number;
    properties: Record<string, any>;
  }>;
  wires: Array<{
    id: string;
    start: { componentId: string; pinName: string };
    end: { componentId: string; pinName: string };
    color: string;
  }>;
  thumbnail?: string;
}

export const exampleProjects: ExampleProject[] = [
  {
    id: 'blink-led',
    title: 'Blink LED',
    description: 'Classic Arduino blink example - toggle an LED on and off',
    category: 'basics',
    difficulty: 'beginner',
    code: `// Blink LED Example
// Toggles the built-in LED on pin 13

void setup() {
  pinMode(13, OUTPUT);
}

void loop() {
  digitalWrite(13, HIGH);
  delay(1000);
  digitalWrite(13, LOW);
  delay(1000);
}`,
    components: [
      {
        type: 'wokwi-arduino-uno',
        id: 'arduino-uno',
        x: 100,
        y: 100,
        properties: {},
      },
    ],
    wires: [],
  },
  {
    id: 'traffic-light',
    title: 'Traffic Light',
    description: 'Simulate a traffic light with red, yellow, and green LEDs',
    category: 'basics',
    difficulty: 'beginner',
    code: `// Traffic Light Simulator
// Red -> Yellow -> Green -> Yellow -> Red

const int RED_PIN = 13;
const int YELLOW_PIN = 12;
const int GREEN_PIN = 11;

void setup() {
  pinMode(RED_PIN, OUTPUT);
  pinMode(YELLOW_PIN, OUTPUT);
  pinMode(GREEN_PIN, OUTPUT);
}

void loop() {
  // Red light
  digitalWrite(RED_PIN, HIGH);
  delay(3000);
  digitalWrite(RED_PIN, LOW);

  // Yellow light
  digitalWrite(YELLOW_PIN, HIGH);
  delay(1000);
  digitalWrite(YELLOW_PIN, LOW);

  // Green light
  digitalWrite(GREEN_PIN, HIGH);
  delay(3000);
  digitalWrite(GREEN_PIN, LOW);

  // Yellow light again
  digitalWrite(YELLOW_PIN, HIGH);
  delay(1000);
  digitalWrite(YELLOW_PIN, LOW);
}`,
    components: [
      {
        type: 'wokwi-arduino-uno',
        id: 'arduino-uno',
        x: 100,
        y: 100,
        properties: {},
      },
      {
        type: 'wokwi-led',
        id: 'led-red',
        x: 400,
        y: 100,
        properties: { color: 'red', pin: 13 },
      },
      {
        type: 'wokwi-led',
        id: 'led-yellow',
        x: 400,
        y: 200,
        properties: { color: 'yellow', pin: 12 },
      },
      {
        type: 'wokwi-led',
        id: 'led-green',
        x: 400,
        y: 300,
        properties: { color: 'green', pin: 11 },
      },
    ],
    wires: [
      {
        id: 'wire-red',
        start: { componentId: 'arduino-uno', pinName: '13' },
        end: { componentId: 'led-red', pinName: 'A' },
        color: '#ff0000',
      },
      {
        id: 'wire-yellow',
        start: { componentId: 'arduino-uno', pinName: '12' },
        end: { componentId: 'led-yellow', pinName: 'A' },
        color: '#ffaa00',
      },
      {
        id: 'wire-green',
        start: { componentId: 'arduino-uno', pinName: '11' },
        end: { componentId: 'led-green', pinName: 'A' },
        color: '#00ff00',
      },
    ],
  },
  {
    id: 'button-led',
    title: 'Button Control',
    description: 'Control an LED with a pushbutton',
    category: 'basics',
    difficulty: 'beginner',
    code: `// Button LED Control
// Press button to turn LED on

const int BUTTON_PIN = 2;
const int LED_PIN = 13;

void setup() {
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  int buttonState = digitalRead(BUTTON_PIN);

  if (buttonState == LOW) {
    digitalWrite(LED_PIN, HIGH);
  } else {
    digitalWrite(LED_PIN, LOW);
  }
}`,
    components: [
      {
        type: 'wokwi-arduino-uno',
        id: 'arduino-uno',
        x: 100,
        y: 100,
        properties: {},
      },
      {
        type: 'wokwi-pushbutton',
        id: 'button-1',
        x: 400,
        y: 100,
        properties: {},
      },
      {
        type: 'wokwi-led',
        id: 'led-1',
        x: 400,
        y: 250,
        properties: { color: 'red', pin: 13 },
      },
    ],
    wires: [
      {
        id: 'wire-button',
        start: { componentId: 'arduino-uno', pinName: '2' },
        end: { componentId: 'button-1', pinName: '1.l' },
        color: '#00aaff',
      },
      {
        id: 'wire-led',
        start: { componentId: 'arduino-uno', pinName: '13' },
        end: { componentId: 'led-1', pinName: 'A' },
        color: '#ff0000',
      },
    ],
  },
  {
    id: 'fade-led',
    title: 'Fade LED',
    description: 'Smoothly fade an LED using PWM',
    category: 'basics',
    difficulty: 'beginner',
    code: `// Fade LED with PWM
// Smoothly fade LED brightness

const int LED_PIN = 9; // PWM pin

int brightness = 0;
int fadeAmount = 5;

void setup() {
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  analogWrite(LED_PIN, brightness);

  brightness += fadeAmount;

  if (brightness <= 0 || brightness >= 255) {
    fadeAmount = -fadeAmount;
  }

  delay(30);
}`,
    components: [
      {
        type: 'wokwi-arduino-uno',
        id: 'arduino-uno',
        x: 100,
        y: 100,
        properties: {},
      },
      {
        type: 'wokwi-led',
        id: 'led-1',
        x: 400,
        y: 150,
        properties: { color: 'blue', pin: 9 },
      },
    ],
    wires: [
      {
        id: 'wire-led',
        start: { componentId: 'arduino-uno', pinName: '9' },
        end: { componentId: 'led-1', pinName: 'A' },
        color: '#0000ff',
      },
    ],
  },
  {
    id: 'serial-hello',
    title: 'Serial Hello World',
    description: 'Send messages through serial communication',
    category: 'communication',
    difficulty: 'beginner',
    code: `// Serial Communication Example
// Send messages to Serial Monitor

void setup() {
  Serial.begin(9600);
  Serial.println("Hello, Arduino!");
  Serial.println("System initialized");
}

void loop() {
  Serial.print("Uptime: ");
  Serial.print(millis() / 1000);
  Serial.println(" seconds");
  delay(2000);
}`,
    components: [
      {
        type: 'wokwi-arduino-uno',
        id: 'arduino-uno',
        x: 100,
        y: 100,
        properties: {},
      },
    ],
    wires: [],
  },
  {
    id: 'rgb-led',
    title: 'RGB LED Colors',
    description: 'Cycle through colors with an RGB LED',
    category: 'basics',
    difficulty: 'intermediate',
    code: `// RGB LED Color Cycling
// Display different colors

const int RED_PIN = 9;
const int GREEN_PIN = 10;
const int BLUE_PIN = 11;

void setup() {
  pinMode(RED_PIN, OUTPUT);
  pinMode(GREEN_PIN, OUTPUT);
  pinMode(BLUE_PIN, OUTPUT);
}

void setColor(int red, int green, int blue) {
  analogWrite(RED_PIN, red);
  analogWrite(GREEN_PIN, green);
  analogWrite(BLUE_PIN, blue);
}

void loop() {
  // Red
  setColor(255, 0, 0);
  delay(1000);

  // Green
  setColor(0, 255, 0);
  delay(1000);

  // Blue
  setColor(0, 0, 255);
  delay(1000);

  // Yellow
  setColor(255, 255, 0);
  delay(1000);

  // Cyan
  setColor(0, 255, 255);
  delay(1000);

  // Magenta
  setColor(255, 0, 255);
  delay(1000);

  // White
  setColor(255, 255, 255);
  delay(1000);
}`,
    components: [
      {
        type: 'wokwi-arduino-uno',
        id: 'arduino-uno',
        x: 100,
        y: 100,
        properties: {},
      },
      {
        type: 'wokwi-rgb-led',
        id: 'rgb-led-1',
        x: 400,
        y: 150,
        properties: {},
      },
    ],
    wires: [
      {
        id: 'wire-red',
        start: { componentId: 'arduino-uno', pinName: '9' },
        end: { componentId: 'rgb-led-1', pinName: 'R' },
        color: '#ff0000',
      },
      {
        id: 'wire-green',
        start: { componentId: 'arduino-uno', pinName: '10' },
        end: { componentId: 'rgb-led-1', pinName: 'G' },
        color: '#00ff00',
      },
      {
        id: 'wire-blue',
        start: { componentId: 'arduino-uno', pinName: '11' },
        end: { componentId: 'rgb-led-1', pinName: 'B' },
        color: '#0000ff',
      },
    ],
  },
  {
    id: 'simon-says',
    title: 'Simon Says Game',
    description: 'Memory game with LEDs and buttons',
    category: 'games',
    difficulty: 'advanced',
    code: `// Simon Says Game
// Memory game with 4 LEDs and buttons

const int LED_PINS[] = {8, 9, 10, 11};
const int BUTTON_PINS[] = {2, 3, 4, 5};
const int NUM_LEDS = 4;

int sequence[100];
int sequenceLength = 0;
int currentStep = 0;

void setup() {
  Serial.begin(9600);

  for (int i = 0; i < NUM_LEDS; i++) {
    pinMode(LED_PINS[i], OUTPUT);
    pinMode(BUTTON_PINS[i], INPUT_PULLUP);
  }

  randomSeed(millis());
  newGame();
}

void newGame() {
  sequenceLength = 1;
  currentStep = 0;
  addToSequence();
  playSequence();
}

void addToSequence() {
  sequence[sequenceLength - 1] = random(0, NUM_LEDS);
}

void playSequence() {
  for (int i = 0; i < sequenceLength; i++) {
    flashLED(sequence[i]);
    delay(500);
  }
}

void flashLED(int led) {
  digitalWrite(LED_PINS[led], HIGH);
  delay(300);
  digitalWrite(LED_PINS[led], LOW);
}

void loop() {
  for (int i = 0; i < NUM_LEDS; i++) {
    if (digitalRead(BUTTON_PINS[i]) == LOW) {
      flashLED(i);

      if (i == sequence[currentStep]) {
        currentStep++;
        if (currentStep == sequenceLength) {
          delay(1000);
          sequenceLength++;
          currentStep = 0;
          addToSequence();
          playSequence();
        }
      } else {
        // Wrong button - game over
        for (int j = 0; j < 3; j++) {
          for (int k = 0; k < NUM_LEDS; k++) {
            digitalWrite(LED_PINS[k], HIGH);
          }
          delay(200);
          for (int k = 0; k < NUM_LEDS; k++) {
            digitalWrite(LED_PINS[k], LOW);
          }
          delay(200);
        }
        newGame();
      }

      delay(300);
      while (digitalRead(BUTTON_PINS[i]) == LOW);
    }
  }
}`,
    components: [
      {
        type: 'wokwi-arduino-uno',
        id: 'arduino-uno',
        x: 100,
        y: 100,
        properties: {},
      },
      {
        type: 'wokwi-led',
        id: 'led-red',
        x: 450,
        y: 100,
        properties: { color: 'red', pin: 8 },
      },
      {
        type: 'wokwi-led',
        id: 'led-green',
        x: 550,
        y: 100,
        properties: { color: 'green', pin: 9 },
      },
      {
        type: 'wokwi-led',
        id: 'led-blue',
        x: 450,
        y: 200,
        properties: { color: 'blue', pin: 10 },
      },
      {
        type: 'wokwi-led',
        id: 'led-yellow',
        x: 550,
        y: 200,
        properties: { color: 'yellow', pin: 11 },
      },
      {
        type: 'wokwi-pushbutton',
        id: 'button-red',
        x: 450,
        y: 300,
        properties: {},
      },
      {
        type: 'wokwi-pushbutton',
        id: 'button-green',
        x: 550,
        y: 300,
        properties: {},
      },
      {
        type: 'wokwi-pushbutton',
        id: 'button-blue',
        x: 450,
        y: 400,
        properties: {},
      },
      {
        type: 'wokwi-pushbutton',
        id: 'button-yellow',
        x: 550,
        y: 400,
        properties: {},
      },
    ],
    wires: [
      {
        id: 'wire-led-red',
        start: { componentId: 'arduino-uno', pinName: '8' },
        end: { componentId: 'led-red', pinName: 'A' },
        color: '#ff0000',
      },
      {
        id: 'wire-led-green',
        start: { componentId: 'arduino-uno', pinName: '9' },
        end: { componentId: 'led-green', pinName: 'A' },
        color: '#00ff00',
      },
      {
        id: 'wire-led-blue',
        start: { componentId: 'arduino-uno', pinName: '10' },
        end: { componentId: 'led-blue', pinName: 'A' },
        color: '#0000ff',
      },
      {
        id: 'wire-led-yellow',
        start: { componentId: 'arduino-uno', pinName: '11' },
        end: { componentId: 'led-yellow', pinName: 'A' },
        color: '#ffaa00',
      },
      {
        id: 'wire-button-red',
        start: { componentId: 'arduino-uno', pinName: '2' },
        end: { componentId: 'button-red', pinName: '1.l' },
        color: '#00aaff',
      },
      {
        id: 'wire-button-green',
        start: { componentId: 'arduino-uno', pinName: '3' },
        end: { componentId: 'button-green', pinName: '1.l' },
        color: '#00aaff',
      },
      {
        id: 'wire-button-blue',
        start: { componentId: 'arduino-uno', pinName: '4' },
        end: { componentId: 'button-blue', pinName: '1.l' },
        color: '#00aaff',
      },
      {
        id: 'wire-button-yellow',
        start: { componentId: 'arduino-uno', pinName: '5' },
        end: { componentId: 'button-yellow', pinName: '1.l' },
        color: '#00aaff',
      },
    ],
  },
  {
    id: 'tft-display',
    title: 'TFT ILI9341 Display',
    description: 'Color TFT display demo: fills, text, and a bouncing ball animation using the Adafruit ILI9341 library (240x320)',
    category: 'displays',
    difficulty: 'intermediate',
    code: `// TFT ILI9341 Display Demo (240x320)
// Library: Adafruit ILI9341 + Adafruit GFX
// Connect: CS=10, DC/RS=9, RST=8, LED=7, MOSI=11(SPI), SCK=13(SPI)

#include <Adafruit_GFX.h>
#include <Adafruit_ILI9341.h>
#include <SPI.h>

#define TFT_CS   10
#define TFT_DC    9
#define TFT_RST   8
#define TFT_LED   7

Adafruit_ILI9341 tft(TFT_CS, TFT_DC, TFT_RST);

// Background color: dark blue
#define BG_COLOR 0x0006

// Ball state
int ballX = 120, ballY = 200;
int ballDX = 3, ballDY = 2;
const int BALL_R = 10;

// Play-field boundaries
const int FX = 5, FY = 110, FW = 230, FH = 200;

void drawStaticUI() {
  tft.fillScreen(BG_COLOR);

  // Title
  tft.setTextSize(3);
  tft.setTextColor(tft.color565(255, 220, 0));
  tft.setCursor(20, 10);
  tft.print("WOKWI TFT");

  // Subtitle
  tft.setTextSize(2);
  tft.setTextColor(tft.color565(180, 180, 255));
  tft.setCursor(30, 50);
  tft.print("ILI9341 Demo");

  // Color palette bars
  tft.fillRect(10, 82, 70, 18, tft.color565(220, 50, 50));
  tft.fillRect(85, 82, 70, 18, tft.color565(50, 200, 50));
  tft.fillRect(160, 82, 70, 18, tft.color565(50, 100, 240));

  // Play-field border
  tft.drawRect(FX, FY, FW, FH, tft.color565(80, 80, 130));
}

void setup() {
  pinMode(TFT_LED, OUTPUT);
  digitalWrite(TFT_LED, HIGH);

  tft.begin();
  drawStaticUI();
}

void loop() {
  // Erase old ball
  tft.fillCircle(ballX, ballY, BALL_R, BG_COLOR);

  // Update position
  ballX += ballDX;
  ballY += ballDY;

  // Bounce off field borders
  if (ballX < FX + BALL_R + 1 || ballX > FX + FW - BALL_R - 1) ballDX = -ballDX;
  if (ballY < FY + BALL_R + 1 || ballY > FY + FH - BALL_R - 1) ballDY = -ballDY;

  // Draw ball
  tft.fillCircle(ballX, ballY, BALL_R, tft.color565(255, 140, 0));

  delay(30);
}
`,
    components: [
      {
        type: 'wokwi-arduino-uno',
        id: 'arduino-uno',
        x: 80,
        y: 220,
        properties: {},
      },
      {
        type: 'wokwi-ili9341',
        id: 'tft1',
        x: 480,
        y: 60,
        properties: {},
      },
    ],
    wires: [
      { id: 'w-sck',  start: { componentId: 'arduino-uno', pinName: '13' }, end: { componentId: 'tft1', pinName: 'SCK'  }, color: '#ff8800' },
      { id: 'w-mosi', start: { componentId: 'arduino-uno', pinName: '11' }, end: { componentId: 'tft1', pinName: 'MOSI' }, color: '#ff8800' },
      { id: 'w-cs',   start: { componentId: 'arduino-uno', pinName: '10' }, end: { componentId: 'tft1', pinName: 'CS'   }, color: '#00aaff' },
      { id: 'w-dc',   start: { componentId: 'arduino-uno', pinName: '9'  }, end: { componentId: 'tft1', pinName: 'D/C'  }, color: '#00cc00' },
      { id: 'w-rst',  start: { componentId: 'arduino-uno', pinName: '8'  }, end: { componentId: 'tft1', pinName: 'RST'  }, color: '#cc0000' },
      { id: 'w-led',  start: { componentId: 'arduino-uno', pinName: '7'  }, end: { componentId: 'tft1', pinName: 'LED'  }, color: '#ffffff' },
    ],
  },
  {
    id: 'lcd-hello',
    title: 'LCD 20x4 Display',
    description: 'Display text on a 20x4 LCD using the LiquidCrystal library',
    category: 'displays',
    difficulty: 'intermediate',
    code: `// LiquidCrystal Library - Hello World
// Demonstrates the use a 20x4 LCD display

#include <LiquidCrystal.h>

// initialize the library by associating any needed LCD interface pin
// with the arduino pin number it is connected to
const int rs = 12, en = 11, d4 = 5, d5 = 4, d6 = 3, d7 = 2;
LiquidCrystal lcd(rs, en, d4, d5, d6, d7);

void setup() {
  // set up the LCD's number of columns and rows:
  lcd.begin(20, 4);
  // Print a message to the LCD.
  lcd.print("Hello, Arduino!");
  lcd.setCursor(0, 1);
  lcd.print("Wokwi Emulator");
  lcd.setCursor(0, 2);
  lcd.print("LCD 2004 Test");
}

void loop() {
  // set the cursor to column 0, line 3
  lcd.setCursor(0, 3);
  // print the number of seconds since reset:
  lcd.print("Uptime: ");
  lcd.print(millis() / 1000);
}
`,
    components: [
      {
        type: 'wokwi-arduino-uno',
        id: 'arduino-uno',
        x: 100,
        y: 100,
        properties: {},
      },
      {
        type: 'wokwi-lcd2004',
        id: 'lcd1',
        x: 450,
        y: 100,
        properties: { pins: 'full' },
      },
    ],
    wires: [
      { id: 'w-rs', start: { componentId: 'arduino-uno', pinName: '12' }, end: { componentId: 'lcd1', pinName: 'RS' }, color: 'green' },
      { id: 'w-en', start: { componentId: 'arduino-uno', pinName: '11' }, end: { componentId: 'lcd1', pinName: 'E' }, color: 'green' },
      { id: 'w-d4', start: { componentId: 'arduino-uno', pinName: '5' }, end: { componentId: 'lcd1', pinName: 'D4' }, color: 'blue' },
      { id: 'w-d5', start: { componentId: 'arduino-uno', pinName: '4' }, end: { componentId: 'lcd1', pinName: 'D5' }, color: 'blue' },
      { id: 'w-d6', start: { componentId: 'arduino-uno', pinName: '3' }, end: { componentId: 'lcd1', pinName: 'D6' }, color: 'blue' },
      { id: 'w-d7', start: { componentId: 'arduino-uno', pinName: '2' }, end: { componentId: 'lcd1', pinName: 'D7' }, color: 'blue' },
      // Power / Contrast logic is usually handled internally or ignored in basic simulation
    ],
  },
  // ─── Protocol Test Examples ──────────────────────────────────────────────
  {
    id: 'serial-echo',
    title: 'Serial Echo (USART)',
    description: 'Tests Serial communication: echoes typed characters back and prints status. Open the Serial Monitor to interact.',
    category: 'communication',
    difficulty: 'beginner',
    code: `// Serial Echo — USART Protocol Test
// Open the Serial Monitor to send and receive data.
// Everything you type is echoed back with extra info.

void setup() {
  Serial.begin(9600);
  Serial.println("=============================");
  Serial.println("  Serial Echo Test (USART)");
  Serial.println("=============================");
  Serial.println("Type something and press Send.");
  Serial.println();

  // Print system info
  Serial.print("CPU Clock: ");
  Serial.print(F_CPU / 1000000);
  Serial.println(" MHz");
  Serial.print("Baud rate: 9600");
  Serial.println();
  Serial.println();
}

unsigned long charCount = 0;

void loop() {
  if (Serial.available() > 0) {
    char c = Serial.read();
    charCount++;

    Serial.print("[");
    Serial.print(charCount);
    Serial.print("] Received: '");
    Serial.print(c);
    Serial.print("' (ASCII ");
    Serial.print((int)c);
    Serial.println(")");
  }

  // Periodic heartbeat
  static unsigned long lastBeat = 0;
  if (millis() - lastBeat >= 5000) {
    lastBeat = millis();
    Serial.print("Uptime: ");
    Serial.print(millis() / 1000);
    Serial.print("s | Chars received: ");
    Serial.println(charCount);
  }
}
`,
    components: [
      { type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 100, y: 100, properties: {} },
    ],
    wires: [],
  },
  {
    id: 'serial-led-control',
    title: 'Serial LED Control',
    description: 'Control an LED via Serial commands: send "1" or "0". Tests USART RX + GPIO output together.',
    category: 'communication',
    difficulty: 'beginner',
    code: `// Serial LED Control
// Send "1" to turn LED ON, "0" to turn LED OFF.
// Demonstrates Serial input controlling hardware.

const int LED_PIN = 13;

void setup() {
  Serial.begin(9600);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  Serial.println("=========================");
  Serial.println(" Serial LED Controller");
  Serial.println("=========================");
  Serial.println("Send '1' = LED ON");
  Serial.println("Send '0' = LED OFF");
  Serial.println("Send '?' = Status");
  Serial.println();
}

bool ledState = false;

void loop() {
  if (Serial.available() > 0) {
    char cmd = Serial.read();

    switch (cmd) {
      case '1':
        digitalWrite(LED_PIN, HIGH);
        ledState = true;
        Serial.println("[OK] LED is ON");
        break;
      case '0':
        digitalWrite(LED_PIN, LOW);
        ledState = false;
        Serial.println("[OK] LED is OFF");
        break;
      case '?':
        Serial.print("[STATUS] LED is ");
        Serial.println(ledState ? "ON" : "OFF");
        Serial.print("[STATUS] Uptime: ");
        Serial.print(millis() / 1000);
        Serial.println("s");
        break;
      default:
        if (cmd >= 32) { // ignore control chars
          Serial.print("[ERR] Unknown command: '");
          Serial.print(cmd);
          Serial.println("'  (use 1, 0, or ?)");
        }
        break;
    }
  }
}
`,
    components: [
      { type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 100, y: 100, properties: {} },
      { type: 'wokwi-led', id: 'led-1', x: 400, y: 120, properties: { color: 'green' } },
    ],
    wires: [
      { id: 'w-led', start: { componentId: 'arduino-uno', pinName: '13' }, end: { componentId: 'led-1', pinName: 'A' }, color: '#00cc00' },
    ],
  },
  {
    id: 'i2c-scanner',
    title: 'I2C Scanner (TWI)',
    description: 'Scans the I2C bus and reports all devices found. Tests TWI protocol. Virtual devices at 0x48, 0x50, 0x68 should be detected.',
    category: 'communication',
    difficulty: 'intermediate',
    code: `// I2C Bus Scanner — TWI Protocol Test
// Scans all 127 I2C addresses and reports which ones respond with ACK.
// The emulator has virtual devices at:
//   0x48 = Temperature sensor
//   0x50 = EEPROM
//   0x68 = DS1307 RTC

#include <Wire.h>

void setup() {
  Wire.begin();
  Serial.begin(9600);

  Serial.println("===========================");
  Serial.println("  I2C Bus Scanner (TWI)");
  Serial.println("===========================");
  Serial.println("Scanning...");
  Serial.println();

  int devicesFound = 0;

  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    byte error = Wire.endTransmission();

    if (error == 0) {
      Serial.print("  Device found at 0x");
      if (addr < 16) Serial.print("0");
      Serial.print(addr, HEX);

      // Identify known addresses
      switch (addr) {
        case 0x27: Serial.print("  (PCF8574 LCD backpack)"); break;
        case 0x3C: Serial.print("  (SSD1306 OLED)"); break;
        case 0x48: Serial.print("  (Temperature sensor)"); break;
        case 0x50: Serial.print("  (EEPROM)"); break;
        case 0x68: Serial.print("  (DS1307 RTC)"); break;
        case 0x76: Serial.print("  (BME280 sensor)"); break;
        case 0x77: Serial.print("  (BMP180/BMP280)"); break;
      }
      Serial.println();
      devicesFound++;
    }
  }

  Serial.println();
  Serial.print("Scan complete. ");
  Serial.print(devicesFound);
  Serial.println(" device(s) found.");

  if (devicesFound == 0) {
    Serial.println("No I2C devices found. Check connections.");
  }
}

void loop() {
  // Rescan every 10 seconds
  delay(10000);
  Serial.println("\\nRescanning...");
  setup();
}
`,
    components: [
      { type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 100, y: 100, properties: {} },
    ],
    wires: [],
  },
  {
    id: 'i2c-rtc-read',
    title: 'I2C RTC Clock (DS1307)',
    description: 'Reads time from a virtual DS1307 RTC via I2C and prints it to Serial. Tests TWI read transactions.',
    category: 'communication',
    difficulty: 'intermediate',
    code: `// I2C RTC Reader — DS1307 at address 0x68
// Reads hours:minutes:seconds from the virtual RTC
// and prints to Serial Monitor every second.

#include <Wire.h>

#define DS1307_ADDR 0x68

byte bcdToDec(byte val) {
  return ((val >> 4) * 10) + (val & 0x0F);
}

void setup() {
  Wire.begin();
  Serial.begin(9600);

  Serial.println("===========================");
  Serial.println("  DS1307 RTC Reader (I2C)");
  Serial.println("===========================");
  Serial.println();
}

void loop() {
  // Set register pointer to 0 (seconds)
  Wire.beginTransmission(DS1307_ADDR);
  Wire.write(0x00);
  Wire.endTransmission();

  // Request 7 bytes: sec, min, hr, dow, date, month, year
  Wire.requestFrom(DS1307_ADDR, 7);

  if (Wire.available() >= 7) {
    byte sec   = bcdToDec(Wire.read() & 0x7F);
    byte min   = bcdToDec(Wire.read());
    byte hr    = bcdToDec(Wire.read() & 0x3F);
    byte dow   = bcdToDec(Wire.read());
    byte date  = bcdToDec(Wire.read());
    byte month = bcdToDec(Wire.read());
    byte year  = bcdToDec(Wire.read());

    // Print formatted time
    Serial.print("Time: ");
    if (hr < 10) Serial.print("0");
    Serial.print(hr);
    Serial.print(":");
    if (min < 10) Serial.print("0");
    Serial.print(min);
    Serial.print(":");
    if (sec < 10) Serial.print("0");
    Serial.print(sec);

    Serial.print("  Date: ");
    if (date < 10) Serial.print("0");
    Serial.print(date);
    Serial.print("/");
    if (month < 10) Serial.print("0");
    Serial.print(month);
    Serial.print("/20");
    if (year < 10) Serial.print("0");
    Serial.println(year);
  } else {
    Serial.println("Error: Could not read RTC");
  }

  delay(1000);
}
`,
    components: [
      { type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 100, y: 100, properties: {} },
    ],
    wires: [],
  },
  {
    id: 'i2c-eeprom-rw',
    title: 'I2C EEPROM Read/Write',
    description: 'Writes data to a virtual I2C EEPROM (0x50) and reads it back. Tests TWI write+read transactions.',
    category: 'communication',
    difficulty: 'intermediate',
    code: `// I2C EEPROM Read/Write Test
// Virtual EEPROM at address 0x50
// Writes values to registers, then reads them back.

#include <Wire.h>

#define EEPROM_ADDR 0x50

void writeEEPROM(byte reg, byte value) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(reg);    // register address
  Wire.write(value);  // data
  Wire.endTransmission();
  delay(5); // EEPROM write cycle time
}

byte readEEPROM(byte reg) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(reg);
  Wire.endTransmission();

  Wire.requestFrom(EEPROM_ADDR, 1);
  if (Wire.available()) {
    return Wire.read();
  }
  return 0xFF;
}

void setup() {
  Wire.begin();
  Serial.begin(9600);

  Serial.println("============================");
  Serial.println(" I2C EEPROM R/W Test (0x50)");
  Serial.println("============================");
  Serial.println();

  // Write test pattern
  Serial.println("Writing test data...");
  for (byte i = 0; i < 8; i++) {
    byte value = (i + 1) * 10;  // 10, 20, 30, ...
    writeEEPROM(i, value);
    Serial.print("  Write reg[");
    Serial.print(i);
    Serial.print("] = ");
    Serial.println(value);
  }

  Serial.println();
  Serial.println("Reading back...");

  // Read back and verify
  byte errors = 0;
  for (byte i = 0; i < 8; i++) {
    byte expected = (i + 1) * 10;
    byte actual = readEEPROM(i);
    Serial.print("  Read  reg[");
    Serial.print(i);
    Serial.print("] = ");
    Serial.print(actual);

    if (actual == expected) {
      Serial.println("  [OK]");
    } else {
      Serial.print("  [FAIL] expected ");
      Serial.println(expected);
      errors++;
    }
  }

  Serial.println();
  if (errors == 0) {
    Serial.println("All tests PASSED!");
  } else {
    Serial.print(errors);
    Serial.println(" test(s) FAILED.");
  }
}

void loop() {
  // Nothing to do
  delay(1000);
}
`,
    components: [
      { type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 100, y: 100, properties: {} },
    ],
    wires: [],
  },
  {
    id: 'spi-loopback',
    title: 'SPI Loopback Test',
    description: 'Tests SPI by sending bytes and reading responses. Demonstrates MOSI/MISO/SCK/SS protocol.',
    category: 'communication',
    difficulty: 'intermediate',
    code: `// SPI Loopback Test
// Sends bytes via SPI and logs the exchange.
// Without a physical slave, the emulator returns the sent byte.

#include <SPI.h>

#define SS_PIN 10

void setup() {
  Serial.begin(9600);
  Serial.println("========================");
  Serial.println("  SPI Protocol Test");
  Serial.println("========================");
  Serial.println();

  pinMode(SS_PIN, OUTPUT);
  digitalWrite(SS_PIN, HIGH);
  SPI.begin();
  SPI.setClockDivider(SPI_CLOCK_DIV16);

  Serial.println("SPI initialized.");
  Serial.print("Clock divider: 16 (");
  Serial.print(F_CPU / 16);
  Serial.println(" Hz)");
  Serial.println();

  // Send test pattern
  Serial.println("Sending test pattern via SPI:");
  byte testData[] = {0xAA, 0x55, 0xFF, 0x00, 0x42, 0xDE, 0xAD, 0xBE};

  digitalWrite(SS_PIN, LOW);  // Select slave

  for (int i = 0; i < sizeof(testData); i++) {
    byte sent = testData[i];
    byte received = SPI.transfer(sent);

    Serial.print("  TX: 0x");
    if (sent < 16) Serial.print("0");
    Serial.print(sent, HEX);
    Serial.print("  RX: 0x");
    if (received < 16) Serial.print("0");
    Serial.print(received, HEX);

    if (sent == received) {
      Serial.println("  (loopback OK)");
    } else {
      Serial.println();
    }
  }

  digitalWrite(SS_PIN, HIGH);  // Deselect slave

  Serial.println();
  Serial.println("SPI test complete.");
}

void loop() {
  delay(1000);
}
`,
    components: [
      { type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 100, y: 100, properties: {} },
    ],
    wires: [],
  },
  {
    id: 'multi-protocol',
    title: 'Multi-Protocol Demo',
    description: 'Uses Serial + I2C + SPI together. Reads RTC via I2C, sends SPI data, and logs everything to Serial.',
    category: 'communication',
    difficulty: 'advanced',
    code: `// Multi-Protocol Demo: Serial + I2C + SPI
// Demonstrates all three major communication protocols
// working together in a single sketch.

#include <Wire.h>
#include <SPI.h>

#define DS1307_ADDR 0x68
#define EEPROM_ADDR 0x50
#define SS_PIN 10

byte bcdToDec(byte val) {
  return ((val >> 4) * 10) + (val & 0x0F);
}

void readRTC(byte &hr, byte &min, byte &sec) {
  Wire.beginTransmission(DS1307_ADDR);
  Wire.write(0x00);
  Wire.endTransmission();
  Wire.requestFrom(DS1307_ADDR, 3);
  sec = bcdToDec(Wire.read() & 0x7F);
  min = bcdToDec(Wire.read());
  hr  = bcdToDec(Wire.read() & 0x3F);
}

void writeEEPROM(byte reg, byte value) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(reg);
  Wire.write(value);
  Wire.endTransmission();
  delay(5);
}

byte readEEPROM(byte reg) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(reg);
  Wire.endTransmission();
  Wire.requestFrom(EEPROM_ADDR, 1);
  return Wire.available() ? Wire.read() : 0xFF;
}

byte spiTransfer(byte data) {
  digitalWrite(SS_PIN, LOW);
  byte result = SPI.transfer(data);
  digitalWrite(SS_PIN, HIGH);
  return result;
}

void setup() {
  Serial.begin(9600);
  Wire.begin();
  pinMode(SS_PIN, OUTPUT);
  digitalWrite(SS_PIN, HIGH);
  SPI.begin();

  Serial.println("===================================");
  Serial.println(" Multi-Protocol Demo");
  Serial.println(" Serial (USART) + I2C (TWI) + SPI");
  Serial.println("===================================");
  Serial.println();

  // ── I2C: Scan bus ──
  Serial.println("[I2C] Scanning bus...");
  int found = 0;
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.print("  Found device at 0x");
      if (addr < 16) Serial.print("0");
      Serial.println(addr, HEX);
      found++;
    }
  }
  Serial.print("  ");
  Serial.print(found);
  Serial.println(" device(s) on I2C bus.");
  Serial.println();

  // ── I2C: Write/read EEPROM ──
  Serial.println("[I2C] EEPROM write/read test:");
  writeEEPROM(0, 42);
  writeEEPROM(1, 99);
  byte v0 = readEEPROM(0);
  byte v1 = readEEPROM(1);
  Serial.print("  Wrote 42, read ");
  Serial.print(v0);
  Serial.println(v0 == 42 ? " [OK]" : " [FAIL]");
  Serial.print("  Wrote 99, read ");
  Serial.print(v1);
  Serial.println(v1 == 99 ? " [OK]" : " [FAIL]");
  Serial.println();

  // ── SPI: Transfer test ──
  Serial.println("[SPI] Transfer test:");
  byte spiData[] = {0xAA, 0x55, 0x42};
  for (int i = 0; i < 3; i++) {
    byte rx = spiTransfer(spiData[i]);
    Serial.print("  TX=0x");
    if (spiData[i] < 16) Serial.print("0");
    Serial.print(spiData[i], HEX);
    Serial.print(" RX=0x");
    if (rx < 16) Serial.print("0");
    Serial.println(rx, HEX);
  }
  Serial.println();

  Serial.println("Setup complete. Reading RTC...");
  Serial.println();
}

void loop() {
  // ── Serial: Print RTC time every 2 seconds ──
  byte hr, min, sec;
  readRTC(hr, min, sec);

  Serial.print("[RTC] ");
  if (hr < 10) Serial.print("0");
  Serial.print(hr);
  Serial.print(":");
  if (min < 10) Serial.print("0");
  Serial.print(min);
  Serial.print(":");
  if (sec < 10) Serial.print("0");
  Serial.print(sec);

  Serial.print("  |  Uptime: ");
  Serial.print(millis() / 1000);
  Serial.println("s");

  delay(2000);
}
`,
    components: [
      { type: 'wokwi-arduino-uno', id: 'arduino-uno', x: 100, y: 100, properties: {} },
    ],
    wires: [],
  },

  // ──────────────────────────────────────────────────────────────────────────
  // Raspberry Pi Pico (RP2040) Examples
  // ──────────────────────────────────────────────────────────────────────────

  {
    id: 'pico-blink',
    title: '[Pico] Blink LED',
    description: 'Classic blink example on Raspberry Pi Pico — GPIO25 built-in LED',
    category: 'basics',
    difficulty: 'beginner',
    boardType: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — Blink LED
// Toggles the onboard LED on GPIO 25

void setup() {
  pinMode(LED_BUILTIN, OUTPUT); // GPIO 25
  Serial.begin(115200);
  Serial.println("Pico Blink Example");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  Serial.println("LED ON");
  delay(500);

  digitalWrite(LED_BUILTIN, LOW);
  Serial.println("LED OFF");
  delay(500);
}
`,
    components: [
      { type: 'wokwi-led', id: 'led-blink', x: 400, y: 120, properties: { color: 'green' } },
      { type: 'wokwi-resistor', id: 'r1', x: 400, y: 200, properties: { resistance: '220' } },
    ],
    wires: [
      { id: 'w1', start: { componentId: 'nano-rp2040', pinName: 'D2' }, end: { componentId: 'led-blink', pinName: 'A' }, color: '#00cc00' },
      { id: 'w2', start: { componentId: 'led-blink', pinName: 'C' }, end: { componentId: 'r1', pinName: '1' }, color: '#999999' },
    ],
  },

  {
    id: 'pico-serial-echo',
    title: '[Pico] Serial Echo',
    description: 'Echo serial input back with a timestamp — tests UART on RP2040',
    category: 'communication',
    difficulty: 'beginner',
    boardType: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — Serial Echo Test
// Echoes received characters and prints a heartbeat every 2 seconds

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("=== Pico Serial Echo ===");
  Serial.println("Type something and press Enter.");
  Serial.println();
}

unsigned long lastHeartbeat = 0;

void loop() {
  // Echo any incoming characters
  while (Serial.available()) {
    char c = Serial.read();
    Serial.print("Echo: ");
    Serial.println(c);
  }

  // Heartbeat every 2 seconds
  if (millis() - lastHeartbeat >= 2000) {
    lastHeartbeat = millis();
    Serial.print("[Heartbeat] Uptime: ");
    Serial.print(millis() / 1000);
    Serial.println("s");
  }
}
`,
    components: [
      { type: 'wokwi-led', id: 'led-rx', x: 400, y: 120, properties: { color: 'yellow' } },
    ],
    wires: [
      { id: 'w1', start: { componentId: 'nano-rp2040', pinName: 'TX' }, end: { componentId: 'led-rx', pinName: 'A' }, color: '#ff8800' },
    ],
  },

  {
    id: 'pico-serial-led-control',
    title: '[Pico] Serial LED Control',
    description: 'Control the Pico LED via serial commands (1=ON, 0=OFF, ?=status)',
    category: 'communication',
    difficulty: 'beginner',
    boardType: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — Serial LED Control
// Send '1' to turn LED ON, '0' to turn OFF, '?' for status

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
  delay(500);
  Serial.println("=== Pico LED Control ===");
  Serial.println("Commands: 1=ON  0=OFF  ?=status");
}

void loop() {
  if (Serial.available()) {
    char cmd = Serial.read();
    switch (cmd) {
      case '1':
        digitalWrite(LED_BUILTIN, HIGH);
        Serial.println("LED: ON");
        break;
      case '0':
        digitalWrite(LED_BUILTIN, LOW);
        Serial.println("LED: OFF");
        break;
      case '?':
        Serial.print("LED: ");
        Serial.println(digitalRead(LED_BUILTIN) ? "ON" : "OFF");
        break;
      default:
        if (cmd >= ' ') {
          Serial.print("Unknown command: ");
          Serial.println(cmd);
        }
        break;
    }
  }
}
`,
    components: [
      { type: 'wokwi-led', id: 'led-status', x: 400, y: 120, properties: { color: 'green' } },
      { type: 'wokwi-resistor', id: 'r1', x: 400, y: 200, properties: { resistance: '220' } },
    ],
    wires: [
      { id: 'w1', start: { componentId: 'nano-rp2040', pinName: 'D2' }, end: { componentId: 'led-status', pinName: 'A' }, color: '#00cc00' },
      { id: 'w2', start: { componentId: 'led-status', pinName: 'C' }, end: { componentId: 'r1', pinName: '1' }, color: '#999999' },
    ],
  },

  {
    id: 'pico-i2c-scanner',
    title: '[Pico] I2C Scanner',
    description: 'Scan the I2C bus on the Pico for connected devices',
    category: 'communication',
    difficulty: 'intermediate',
    boardType: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — I2C Scanner
// Scans I2C bus (Wire / I2C0: SDA=GP4, SCL=GP5) for devices

#include <Wire.h>

void setup() {
  Serial.begin(115200);
  delay(500);
  Wire.begin(); // SDA=GP4, SCL=GP5 by default on Pico
  Serial.println("=== Pico I2C Scanner ===");
  Serial.println("Default I2C0: SDA=GP4, SCL=GP5");
  Serial.println();
}

void loop() {
  Serial.println("Scanning I2C bus...");
  int found = 0;

  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    byte error = Wire.endTransmission();

    if (error == 0) {
      found++;
      Serial.print("  Device found at 0x");
      if (addr < 16) Serial.print("0");
      Serial.print(addr, HEX);

      // Identify known addresses
      switch (addr) {
        case 0x48: Serial.print(" (Temperature sensor)"); break;
        case 0x50: Serial.print(" (EEPROM)"); break;
        case 0x68: Serial.print(" (DS1307 RTC)"); break;
        case 0x27: Serial.print(" (LCD backpack)"); break;
        case 0x3C: Serial.print(" (SSD1306 OLED)"); break;
        default: break;
      }
      Serial.println();
    }
  }

  Serial.print("Scan complete. Found ");
  Serial.print(found);
  Serial.println(" device(s).");
  Serial.println();
  delay(5000);
}
`,
    components: [
      { type: 'wokwi-led', id: 'led-scan', x: 400, y: 100, properties: { color: 'blue' } },
      { type: 'wokwi-led', id: 'led-found', x: 400, y: 180, properties: { color: 'green' } },
    ],
    wires: [
      { id: 'w1', start: { componentId: 'nano-rp2040', pinName: 'D12' }, end: { componentId: 'led-scan', pinName: 'A' }, color: '#4488ff' },
      { id: 'w2', start: { componentId: 'nano-rp2040', pinName: 'D10' }, end: { componentId: 'led-found', pinName: 'A' }, color: '#00cc00' },
    ],
  },

  {
    id: 'pico-i2c-rtc-read',
    title: '[Pico] I2C RTC Read',
    description: 'Read time from a virtual DS1307 RTC over I2C on Raspberry Pi Pico',
    category: 'communication',
    difficulty: 'intermediate',
    boardType: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — I2C DS1307 RTC Read
// Reads time from virtual RTC at address 0x68

#include <Wire.h>

byte bcdToDec(byte val) {
  return ((val >> 4) * 10) + (val & 0x0F);
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Wire.begin();
  Serial.println("=== Pico I2C RTC Read ===");
  Serial.println("Reading DS1307 at 0x68 (system time)");
  Serial.println();
}

void loop() {
  // Set register pointer to 0
  Wire.beginTransmission(0x68);
  Wire.write(0x00);
  Wire.endTransmission();

  // Read 7 bytes: sec, min, hr, dow, date, month, year
  Wire.requestFrom(0x68, 7);
  if (Wire.available() >= 7) {
    byte sec   = bcdToDec(Wire.read() & 0x7F);
    byte min   = bcdToDec(Wire.read());
    byte hr    = bcdToDec(Wire.read() & 0x3F);
    byte dow   = bcdToDec(Wire.read());
    byte date  = bcdToDec(Wire.read());
    byte month = bcdToDec(Wire.read());
    byte year  = bcdToDec(Wire.read());

    const char* days[] = {"", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};

    Serial.print("Time: ");
    if (hr < 10) Serial.print('0'); Serial.print(hr); Serial.print(':');
    if (min < 10) Serial.print('0'); Serial.print(min); Serial.print(':');
    if (sec < 10) Serial.print('0'); Serial.print(sec);
    Serial.print("  Date: ");
    Serial.print(days[dow]); Serial.print(' ');
    if (date < 10) Serial.print('0'); Serial.print(date); Serial.print('/');
    if (month < 10) Serial.print('0'); Serial.print(month); Serial.print('/');
    Serial.print("20"); if (year < 10) Serial.print('0'); Serial.println(year);
  } else {
    Serial.println("RTC not responding!");
  }

  delay(1000);
}
`,
    components: [
      { type: 'wokwi-led', id: 'led-i2c', x: 400, y: 100, properties: { color: 'blue' } },
      { type: 'wokwi-led', id: 'led-rtc', x: 400, y: 180, properties: { color: 'yellow' } },
    ],
    wires: [
      { id: 'w-sda', start: { componentId: 'nano-rp2040', pinName: 'D12' }, end: { componentId: 'led-i2c', pinName: 'A' }, color: '#4488ff' },
      { id: 'w-scl', start: { componentId: 'nano-rp2040', pinName: 'D10' }, end: { componentId: 'led-rtc', pinName: 'A' }, color: '#ffaa00' },
    ],
  },

  {
    id: 'pico-i2c-eeprom-rw',
    title: '[Pico] I2C EEPROM R/W',
    description: 'Write and read back data to a virtual I2C EEPROM on the Pico',
    category: 'communication',
    difficulty: 'intermediate',
    boardType: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — I2C EEPROM Read/Write
// Writes data to virtual EEPROM at 0x50 and reads it back

#include <Wire.h>

#define EEPROM_ADDR 0x50

void eepromWrite(byte memAddr, byte data) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(memAddr);
  Wire.write(data);
  Wire.endTransmission();
  delay(5); // EEPROM write cycle
}

byte eepromRead(byte memAddr) {
  Wire.beginTransmission(EEPROM_ADDR);
  Wire.write(memAddr);
  Wire.endTransmission();
  Wire.requestFrom(EEPROM_ADDR, 1);
  return Wire.available() ? Wire.read() : 0xFF;
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Wire.begin();
  Serial.println("=== Pico I2C EEPROM Test ===");
  Serial.println();

  // Write 8 bytes
  Serial.println("Writing 8 bytes...");
  byte testData[] = {0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE};
  for (int i = 0; i < 8; i++) {
    eepromWrite(i, testData[i]);
    Serial.print("  ["); Serial.print(i);
    Serial.print("] = 0x");
    if (testData[i] < 16) Serial.print('0');
    Serial.println(testData[i], HEX);
  }
  Serial.println();

  // Read back
  Serial.println("Reading back...");
  int pass = 0;
  for (int i = 0; i < 8; i++) {
    byte val = eepromRead(i);
    Serial.print("  ["); Serial.print(i);
    Serial.print("] = 0x");
    if (val < 16) Serial.print('0');
    Serial.print(val, HEX);
    if (val == testData[i]) {
      Serial.println(" OK");
      pass++;
    } else {
      Serial.print(" FAIL (expected 0x");
      Serial.print(testData[i], HEX);
      Serial.println(")");
    }
  }

  Serial.println();
  Serial.print("Result: ");
  Serial.print(pass);
  Serial.println("/8 passed");
}

void loop() {
  delay(10000);
}
`,
    components: [
      { type: 'wokwi-led', id: 'led-write', x: 400, y: 100, properties: { color: 'red' } },
      { type: 'wokwi-led', id: 'led-read', x: 400, y: 180, properties: { color: 'green' } },
    ],
    wires: [
      { id: 'w-sda', start: { componentId: 'nano-rp2040', pinName: 'D12' }, end: { componentId: 'led-write', pinName: 'A' }, color: '#ff4444' },
      { id: 'w-scl', start: { componentId: 'nano-rp2040', pinName: 'D10' }, end: { componentId: 'led-read', pinName: 'A' }, color: '#00cc00' },
    ],
  },

  {
    id: 'pico-spi-loopback',
    title: '[Pico] SPI Loopback',
    description: 'SPI loopback test on RP2040 — sends and receives bytes via SPI0',
    category: 'communication',
    difficulty: 'intermediate',
    boardType: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — SPI Loopback Test
// Sends bytes over SPI0 and reads the loopback response
// Default SPI0 pins: MISO=GP16, MOSI=GP19, SCK=GP18, CS=GP17

#include <SPI.h>

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("=== Pico SPI Loopback Test ===");
  Serial.println("SPI0: MISO=GP16, MOSI=GP19, SCK=GP18");
  Serial.println();

  SPI.begin();
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));

  // Send test bytes
  byte testBytes[] = {0x55, 0xAA, 0xFF, 0x00, 0x42};
  int count = sizeof(testBytes);

  Serial.println("Sending bytes and reading loopback:");
  for (int i = 0; i < count; i++) {
    byte rxByte = SPI.transfer(testBytes[i]);
    Serial.print("  TX: 0x");
    if (testBytes[i] < 16) Serial.print('0');
    Serial.print(testBytes[i], HEX);
    Serial.print("  RX: 0x");
    if (rxByte < 16) Serial.print('0');
    Serial.print(rxByte, HEX);
    Serial.print("  ");
    Serial.println(rxByte == testBytes[i] ? "MATCH" : "DIFFER");
  }

  SPI.endTransaction();
  Serial.println();
  Serial.println("SPI test complete.");
}

void loop() {
  delay(10000);
}
`,
    components: [
      { type: 'wokwi-led', id: 'led-mosi', x: 400, y: 100, properties: { color: 'red' } },
      { type: 'wokwi-led', id: 'led-miso', x: 400, y: 180, properties: { color: 'green' } },
      { type: 'wokwi-led', id: 'led-sck', x: 400, y: 260, properties: { color: 'yellow' } },
    ],
    wires: [
      { id: 'w-mosi', start: { componentId: 'nano-rp2040', pinName: 'D7' }, end: { componentId: 'led-mosi', pinName: 'A' }, color: '#ff4444' },
      { id: 'w-miso', start: { componentId: 'nano-rp2040', pinName: 'D4' }, end: { componentId: 'led-miso', pinName: 'A' }, color: '#00cc00' },
      { id: 'w-sck', start: { componentId: 'nano-rp2040', pinName: 'D6' }, end: { componentId: 'led-sck', pinName: 'A' }, color: '#ffaa00' },
    ],
  },

  {
    id: 'pico-adc-read',
    title: '[Pico] ADC Read',
    description: 'Read analog values from GPIO26-28 and internal temperature sensor',
    category: 'sensors',
    difficulty: 'beginner',
    boardType: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — ADC Read Test
// Reads analog values from A0-A2 (GPIO26-28) and the internal temp sensor

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("=== Pico ADC Read ===");
  Serial.println("A0=GP26  A1=GP27  A2=GP28  Temp=internal");
  Serial.println("12-bit resolution (0-4095), 3.3V ref");
  Serial.println();

  analogReadResolution(12);
}

void loop() {
  int a0 = analogRead(A0);
  int a1 = analogRead(A1);
  int a2 = analogRead(A2);

  // Internal temperature sensor on channel 4
  // T = 27 - (V - 0.706) / 0.001721
  int tempRaw = analogRead(A3); // Channel 4 mapped to A3 by Pico core
  float voltage = tempRaw * 3.3f / 4095.0f;
  float tempC = 27.0f - (voltage - 0.706f) / 0.001721f;

  Serial.print("A0: "); Serial.print(a0);
  Serial.print("  A1: "); Serial.print(a1);
  Serial.print("  A2: "); Serial.print(a2);
  Serial.print("  Temp: "); Serial.print(tempC, 1); Serial.println(" C");

  delay(1000);
}
`,
    components: [
      { type: 'wokwi-potentiometer', id: 'pot-a0', x: 400, y: 80, properties: {} },
      { type: 'wokwi-potentiometer', id: 'pot-a1', x: 400, y: 200, properties: {} },
      { type: 'wokwi-led', id: 'led-temp', x: 400, y: 320, properties: { color: 'red' } },
    ],
    wires: [
      { id: 'w-a0', start: { componentId: 'nano-rp2040', pinName: 'A0' }, end: { componentId: 'pot-a0', pinName: 'SIG' }, color: '#4488ff' },
      { id: 'w-a1', start: { componentId: 'nano-rp2040', pinName: 'A1' }, end: { componentId: 'pot-a1', pinName: 'SIG' }, color: '#44cc44' },
      { id: 'w-temp', start: { componentId: 'nano-rp2040', pinName: 'D2' }, end: { componentId: 'led-temp', pinName: 'A' }, color: '#ff4444' },
    ],
  },

  {
    id: 'pico-multi-protocol',
    title: '[Pico] Multi-Protocol Demo',
    description: 'Comprehensive test: Serial + I2C + SPI + ADC on the Raspberry Pi Pico',
    category: 'communication',
    difficulty: 'advanced',
    boardType: 'raspberry-pi-pico',
    code: `// Raspberry Pi Pico — Multi-Protocol Demo
// Tests Serial, I2C, SPI, and ADC all together

#include <Wire.h>
#include <SPI.h>

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
  delay(500);

  Serial.println("==============================");
  Serial.println(" Pico Multi-Protocol Demo");
  Serial.println("==============================");
  Serial.println();

  // ── 1. I2C Scanner ──
  Wire.begin();
  Serial.println("[I2C] Scanning bus...");
  int found = 0;
  for (byte addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      found++;
      Serial.print("  Found device at 0x");
      if (addr < 16) Serial.print('0');
      Serial.println(addr, HEX);
    }
  }
  Serial.print("  Total devices: "); Serial.println(found);
  Serial.println();

  // ── 2. I2C EEPROM R/W ──
  Serial.println("[I2C] EEPROM test at 0x50...");
  Wire.beginTransmission(0x50);
  Wire.write(0x00); // register 0
  Wire.write(0x42); // data
  Wire.endTransmission();
  delay(5);

  Wire.beginTransmission(0x50);
  Wire.write(0x00);
  Wire.endTransmission();
  Wire.requestFrom(0x50, 1);
  if (Wire.available()) {
    byte val = Wire.read();
    Serial.print("  Wrote 0x42, Read 0x");
    Serial.print(val, HEX);
    Serial.println(val == 0x42 ? " — OK" : " — FAIL");
  }
  Serial.println();

  // ── 3. I2C RTC ──
  Serial.println("[I2C] Reading DS1307 RTC at 0x68...");
  Wire.beginTransmission(0x68);
  Wire.write(0x00);
  Wire.endTransmission();
  Wire.requestFrom(0x68, 3);
  if (Wire.available() >= 3) {
    byte sec = ((Wire.read() & 0x7F) >> 4) * 10 + (Wire.read() & 0x0F);
    byte min2 = Wire.read();
    (void)sec; (void)min2;
    Serial.println("  RTC responded OK");
  }
  Serial.println();

  // ── 4. SPI Loopback ──
  Serial.println("[SPI] Loopback test...");
  SPI.begin();
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  byte tx = 0xAB;
  byte rx = SPI.transfer(tx);
  Serial.print("  TX: 0x"); Serial.print(tx, HEX);
  Serial.print("  RX: 0x"); Serial.println(rx, HEX);
  SPI.endTransaction();
  Serial.println();

  // ── 5. ADC ──
  Serial.println("[ADC] Reading analog channels...");
  analogReadResolution(12);
  int a0 = analogRead(A0);
  Serial.print("  A0 (GP26): "); Serial.println(a0);
  Serial.println();

  // ── 6. GPIO ──
  Serial.println("[GPIO] Blinking LED...");
  for (int i = 0; i < 3; i++) {
    digitalWrite(LED_BUILTIN, HIGH);
    delay(200);
    digitalWrite(LED_BUILTIN, LOW);
    delay(200);
  }
  Serial.println("  3 blinks done");
  Serial.println();

  Serial.println("=== All protocol tests complete ===");
}

void loop() {
  // Heartbeat
  static unsigned long last = 0;
  if (millis() - last >= 3000) {
    last = millis();
    Serial.print("[Heartbeat] ");
    Serial.print(millis() / 1000);
    Serial.println("s");
  }
}
`,
    components: [
      { type: 'wokwi-led', id: 'led-i2c', x: 400, y: 80, properties: { color: 'blue' } },
      { type: 'wokwi-led', id: 'led-spi', x: 400, y: 160, properties: { color: 'yellow' } },
      { type: 'wokwi-potentiometer', id: 'pot-adc', x: 400, y: 240, properties: {} },
      { type: 'wokwi-led', id: 'led-gpio', x: 400, y: 360, properties: { color: 'green' } },
    ],
    wires: [
      { id: 'w-i2c', start: { componentId: 'nano-rp2040', pinName: 'D12' }, end: { componentId: 'led-i2c', pinName: 'A' }, color: '#4488ff' },
      { id: 'w-spi', start: { componentId: 'nano-rp2040', pinName: 'D7' }, end: { componentId: 'led-spi', pinName: 'A' }, color: '#ffaa00' },
      { id: 'w-adc', start: { componentId: 'nano-rp2040', pinName: 'A0' }, end: { componentId: 'pot-adc', pinName: 'SIG' }, color: '#cc44cc' },
      { id: 'w-gpio', start: { componentId: 'nano-rp2040', pinName: 'D2' }, end: { componentId: 'led-gpio', pinName: 'A' }, color: '#00cc00' },
    ],
  },
];

// Get examples by category
export function getExamplesByCategory(category: ExampleProject['category']): ExampleProject[] {
  return exampleProjects.filter((example) => example.category === category);
}

// Get example by ID
export function getExampleById(id: string): ExampleProject | undefined {
  return exampleProjects.find((example) => example.id === id);
}

// Get all categories
export function getCategories(): ExampleProject['category'][] {
  return ['basics', 'sensors', 'displays', 'communication', 'games', 'robotics'];
}
