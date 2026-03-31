# If Arduino component is available, use C++ main and link Arduino
if(DEFINED ENV{ARDUINO_ESP32_PATH})
    idf_component_register(
        SRCS "main.cpp"
        INCLUDE_DIRS "."
        REQUIRES arduino
    )
else()
    # Pure ESP-IDF mode: main.c #includes sketch_translated.c
    idf_component_register(
        SRCS "main.c"
        INCLUDE_DIRS "."
    )
endif()
