cmake_minimum_required(VERSION 3.25)
set(COHERENT_VERSION "0.2.0" CACHE STRING "Coherent version")
project(CoherentDesktop VERSION "${COHERENT_VERSION}" LANGUAGES CXX)

if(NOT WIN32 OR NOT MSVC)
    message(FATAL_ERROR "Build this Windows client with the MSVC x64 toolchain.")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")
set(CMAKE_AUTOMOC ON)

find_package(Qt6 6.10 REQUIRED COMPONENTS Quick QuickControls2 Network WebSockets Multimedia)
qt_standard_project_setup(REQUIRES 6.10)

list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")
include(LiveKitSDK)
livekit_sdk_setup(
    VERSION "1.5.0"
    SHA256 "ff5c6d1f5a96bf0df11208aa1b5acabb50e65f4d28e41d67521e2a67dc3e0f04"
    SDK_DIR "${CMAKE_BINARY_DIR}/_deps/livekit-sdk"
    GITHUB_TOKEN "$ENV{GITHUB_TOKEN}")
find_package(LiveKit CONFIG REQUIRED)

set(VELOPACK_VERSION "1.2.161")
set(VELOPACK_SHA256 "31DE8F2CF05A47BD5328A9F98B0C41AEC1582156F6075F1058B26941F7F17C20")
set(VELOPACK_ARCHIVE "${CMAKE_BINARY_DIR}/_deps/velopack_libc_${VELOPACK_VERSION}.zip")
set(VELOPACK_DIR "${CMAKE_BINARY_DIR}/_deps/velopack")
file(MAKE_DIRECTORY "${CMAKE_BINARY_DIR}/_deps")
if(NOT EXISTS "${VELOPACK_ARCHIVE}")
    file(DOWNLOAD
        "https://github.com/velopack/velopack/releases/download/${VELOPACK_VERSION}/velopack_libc_${VELOPACK_VERSION}.zip"
        "${VELOPACK_ARCHIVE}"
        EXPECTED_HASH "SHA256=${VELOPACK_SHA256}"
        TLS_VERIFY ON
        STATUS download_status)
    list(GET download_status 0 download_code)
    if(NOT download_code EQUAL 0)
        message(FATAL_ERROR "Velopack download failed: ${download_status}")
    endif()
endif()
file(SHA256 "${VELOPACK_ARCHIVE}" velopack_actual_sha)
string(TOLOWER "${VELOPACK_SHA256}" velopack_expected_sha)
if(NOT velopack_actual_sha STREQUAL velopack_expected_sha)
    message(FATAL_ERROR "Velopack archive hash mismatch")
endif()
if(NOT EXISTS "${VELOPACK_DIR}/include/Velopack.hpp")
    file(MAKE_DIRECTORY "${VELOPACK_DIR}")
    file(ARCHIVE_EXTRACT INPUT "${VELOPACK_ARCHIVE}" DESTINATION "${VELOPACK_DIR}")
endif()

configure_file(src/version.h.in "${CMAKE_BINARY_DIR}/generated/version.h" @ONLY)

qt_add_executable(CoherentDesktop WIN32
    src/main.cpp
    src/ApiClient.h src/ApiClient.cpp
    src/AppController.h src/AppController.cpp
    src/CallEngine.h src/CallEngine.cpp
    src/ProcessLoopbackCapture.h src/ProcessLoopbackCapture.cpp
    src/NativeUpdater.h src/NativeUpdater.cpp
)

set_source_files_properties(qml/Theme.qml PROPERTIES QT_QML_SINGLETON_TYPE TRUE)
qt_add_qml_module(CoherentDesktop
    URI Coherent
    VERSION 1.0
    QML_FILES
        qml/Main.qml
        qml/Theme.qml
        qml/ActionButton.qml
)

target_include_directories(CoherentDesktop PRIVATE
    "${CMAKE_BINARY_DIR}/generated"
    "${VELOPACK_DIR}/include"
)
target_link_libraries(CoherentDesktop PRIVATE
    Qt6::Quick Qt6::QuickControls2 Qt6::Network Qt6::WebSockets Qt6::Multimedia
    LiveKit::livekit
    "${VELOPACK_DIR}/lib-static/velopack_libc_win_x64_msvc.lib"
    ole32 user32 advapi32 bcrypt crypt32 winhttp version ws2_32 mmdevapi
)
target_compile_definitions(CoherentDesktop PRIVATE
    UNICODE _UNICODE WINVER=0x0A00 _WIN32_WINNT=0x0A00
    WIN32_LEAN_AND_MEAN NOMINMAX
)
target_compile_options(CoherentDesktop PRIVATE /utf-8 /W4 /permissive- /EHsc /Zc:__cplusplus)
set_target_properties(CoherentDesktop PROPERTIES
    OUTPUT_NAME "Coherent"
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/publish/$<CONFIG>"
)
