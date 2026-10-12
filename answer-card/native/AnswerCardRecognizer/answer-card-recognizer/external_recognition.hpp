#pragma once
#include <filesystem>
#include <nlohmann/json.hpp>
nlohmann::json recognize_external_paper(const std::filesystem::path& image, const std::filesystem::path& layout, const std::filesystem::path& output);
