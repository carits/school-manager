cmake_minimum_required(VERSION 3.20)
project(answer_card_recognizer LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(OpenCV 4.13 REQUIRED COMPONENTS core imgproc imgcodecs objdetect calib3d features2d)
find_package(Eigen3 REQUIRED)
find_package(OpenEXR REQUIRED)
find_package(nlohmann_json 3.7 REQUIRED)

add_executable(answer-card-recognizer
  answer-card-recognizer/main.cpp
  answer-card-recognizer/external_recognition.cpp
  answer-card-recognizer/common.cpp
  answer-card-recognizer/answer_recognition.cpp
  answer-card-recognizer/layout_io.cpp
  answer-card-recognizer/recognizer_limits.cpp
  answer-card-recognizer/vision_utils.cpp
)

target_include_directories(answer-card-recognizer PRIVATE answer-card-recognizer)
target_link_libraries(answer-card-recognizer PRIVATE
  nlohmann_json::nlohmann_json
  ${OpenCV_LIBS}
)

if(UNIX)
  target_link_libraries(answer-card-recognizer PRIVATE pthread dl)
endif()

install(TARGETS answer-card-recognizer RUNTIME DESTINATION bin)
