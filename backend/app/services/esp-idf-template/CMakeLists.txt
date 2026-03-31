cmake_minimum_required(VERSION 3.16)

# Arduino as ESP-IDF component (optional — only if ARDUINO_ESP32_PATH is set)
if(DEFINED ENV{ARDUINO_ESP32_PATH})
    set(EXTRA_COMPONENT_DIRS $ENV{ARDUINO_ESP32_PATH})
endif()

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(velxio-sketch)
