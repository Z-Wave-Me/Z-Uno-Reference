/* 
 * RS485_Blinds.ino
 * RS485_Blinds
 *  
 * Created by Vitaliy Yurkin on 26/11/2019.
 * Copyright © 2019 Z-Wave.Me. All rights reserved.
 * 
 * Control Dooya motors via RS485.
 * Supported commands:
 * -UP
 * -DOWN
 * -STOP
 * -SET LEVEL 
 * 
 * When the position is changed the motor returns feedback
 */

// Maximum number of bytes received from uart
#define INCOMING_BYTES_COUNT 100

// Functions code
#define READ 0x01
#define WRITE 0x02
#define CONTROL 0x03

// Control commands
#define UP 0x01
#define DOWN 0x02
#define STOP 0x03

#define PERCENTAGE 0x04


// State machine 
enum States {
  WAIT_DATA,
  PARSING_DATA,
  SEND_DATA
};

byte bytesCount = 0;
byte incomingData[INCOMING_BYTES_COUNT];
byte state = WAIT_DATA;
byte commandToSend;
byte shadesLevel = 0;
byte lastShadesLevel = 0;

unsigned long lastLevelRequest = 0;

byte command[] = {0x55, 0xfe, 0xfe, 0x00, 0x00, 0x00, 0x00, 0x00};
/*
ZUNO_ENABLE(
  DBG_CONSOLE_BAUDRATE=115200
  LOGGING_DBG
  //LOGGING_UART=Serial0
  );
*/

ZUNO_SETUP_CHANNELS(ZUNO_BLINDS(getterBlinds, setterBlinds));

void setup() {
  Serial1.begin(9600);
  pinMode(2, OUTPUT);
  digitalWrite(2, LOW);
}

void loop() {
  switch(state) {
    case WAIT_DATA:
      getDataFromUART();
      break;
    case PARSING_DATA:
      //LOGGING_UART.print("Parsing ");
      //logData();
      parsingData();
      state = WAIT_DATA;
      break;
    case SEND_DATA:
      //LOGGING_UART.print("Send data ");
      sendDataToUART();
      //logSendData(); 
      state = WAIT_DATA;
      break;
  }
  // Every 2 seconds check shades level
  if ((millis() - lastLevelRequest) > 2000) {
      lastLevelRequest = millis();
      // 55 12 34 01 02 01 2B 4D
        state = SEND_DATA;
        command[3] = READ;
        command[4] = 0x02;
        command[5] = 0x01;
  }
}

void logData() {
  //LOGGING_UART.print("CPU -> Z-Uno: ");
  //LOGGING_UART.dumpPrint(incomingData, 8);
  //LOGGING_UART.println();
}

void logSendData() {
  //LOGGING_UART.print("Z-Uno -> CPU: ");
  //LOGGING_UART.dumpPrint(command, 8);
  //LOGGING_UART.println();
}

void parsingData() {
  // Read data from end
  // FE 1 1 0 44 72
  if (incomingData[bytesCount-5] == 0x01) {
    shadesLevel = incomingData[bytesCount-3];
    shadesLevel = shadesLevel == 100 ? 99 : shadesLevel;
    if (lastShadesLevel != shadesLevel) {
      lastShadesLevel = shadesLevel;
      //LOGGING_UART.print("zunoSendReport: ");
      //LOGGING_UART.println(shadesLevel);
      zunoSendReport(1);
    }
  }
}

void getDataFromUART() {
  byte incomingBytesRead = 0;
  while (Serial1.available() > 0) {
    incomingData[incomingBytesRead++] = Serial1.read();;
    delay(5);
  }

  if (incomingBytesRead) {
    bytesCount = incomingBytesRead;
    state = PARSING_DATA;
  }
}

void sendDataToUART() {
  byte len;

  if (command[4] == PERCENTAGE || command[3] == READ) {
    word crc = modbus_crc16(command, 6);
    command[6] = lowByte(crc);
    command[7] = highByte(crc);
    len = 8;
  }
  else {
    word crc = modbus_crc16(command, 5);
    command[5] = lowByte(crc);
    command[6] = highByte(crc);
    len = 7;
  }

  // Write bytes to serial port
  digitalWrite(2, HIGH);
  delay(5);
  for (byte i = 0; i < len; i++) {
    Serial1.write(command[i]);
  }
    delay(5);
  digitalWrite(2, LOW);
}

// Getters && Setters
byte getterBlinds() {
    return shadesLevel;
}

void setterBlinds(byte level) {
  state = SEND_DATA;
  command[3] = CONTROL;
  
  if (level == 0) {
    command[4] = DOWN;
  }
  else if (level == 99 || level == 255) {
    command[4] = UP;
  }
  else {
    command[4] = PERCENTAGE;
    command[5] = level;
  }
}

void zcustom_SWLStartStopHandler(uint8_t channel, bool start, bool up, uint8_t * p_cmd) {
  (void)p_cmd;
  (void)channel;
  (void)up;
  
  if (!start) {
    state = SEND_DATA;
    command[4] = STOP;
  }
  
  /*
  Serial.print("StartStop Handler channel:"); 
  Serial.print(channel); 
  Serial.print(" start:");  
  Serial.print(start);
  Serial.print(" up:");  
  Serial.println(up);
*/
}


word modbus_crc16(byte* buf, int len) {
  word crc = 0xFFFF;
  
  for (int pos = 0; pos < len; pos++) {
    crc ^= (word)buf[pos];          // XOR byte into least sig. byte of crc
  
    for (int i = 8; i != 0; i--) {    // Loop over each bit
      if ((crc & 0x0001) != 0) {      // If the LSB is set
        crc >>= 1;                    // Shift right and XOR 0xA001
        crc ^= 0xA001;
      }
      else                            // Else LSB is not set
        crc >>= 1;                    // Just shift right
    }
  }
  // Note, this number has low and high bytes swapped, so use it accordingly (or swap bytes)
  return crc; 
}
