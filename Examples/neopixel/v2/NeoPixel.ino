/*
 * This sketch shows how to control WS2811/WS2812 (also known as NeoPixel) right from Z-Uno pins.
 * There is no Z-Wave communication in this example.
 * You can add a Switch Binary channel to turn your LEDs on off or even a Switch Multilevel to define the current LED mode.
 * WS2811/WS2812 control pin should be connected to SPI MOSI (pin 2)
 */

#include "ZUNO_NeoPixel.h"

// Which pin on the Arduino is connected to the NeoPixels?
// On a Trinket or Gemma we suggest changing this to 1:
#define LED_PIN     MOSI

// How many NeoPixels are attached?
#define LED_COUNT  14

// NeoPixel brightness, 0 (min) to 255 (max)
#define BRIGHTNESS 50 // Set BRIGHTNESS to about 1/5 (max = 255)

void setup() {
  NeoPixel.addNeo(LED_PIN, LED_COUNT, BRIGHTNESS, NEO_GRBW | NEO_KHZ800); // Set BRIGHTNESS to about 1/5 (max = 255)
  NeoPixel.show(LED_PIN);            // Turn OFF all pixels
}

// An example of a rainbow equally distributed throughout
void rainbowCycle(uint8_t wait) {
  uint16_t i, j;

  for(j=0; j< 256*5; j++) { // 5 cycles of all colors on wheel
    for(i=0; i< LED_COUNT; i++) {
      NeoPixel.setColor(LED_PIN, i, Wheel(((i * 256 / LED_COUNT) + j) & 255));
    }
    NeoPixel.show(LED_PIN);
    delay(wait);
  }
}
// Input a value 0 to 255 to get a color value.
// The colours are a transition r - g - b - back to r.
ZunoNeoColor_t Wheel(byte WheelPos) {
  WheelPos = 255 - WheelPos;
  if(WheelPos < 85) {
    return NeoPixel.RGB(255 - WheelPos * 3, 0, WheelPos * 3);
  }
  if(WheelPos < 170) {
    WheelPos -= 85;
    return NeoPixel.RGB(0, WheelPos * 3, 255 - WheelPos * 3);
  }
  WheelPos -= 170;
  return NeoPixel.RGB(WheelPos * 3, 255 - WheelPos * 3, 0);
}

void loop() {
  rainbowCycle(5);
}