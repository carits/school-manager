#include "external_recognition.hpp"
#include "vision_utils.hpp"
#include "recognizer_limits.hpp"
#include <algorithm>
#include <cmath>
#include <fstream>
#include <limits>
#include <stdexcept>

using json = nlohmann::json;
namespace {
cv::Mat gray(const cv::Mat& image) {
    if (image.channels() == 1) return image;
    cv::Mat result;
    cv::cvtColor(image, result, image.channels() == 4 ? cv::COLOR_BGRA2GRAY : cv::COLOR_BGR2GRAY);
    return result;
}
cv::Rect rectangle(const json& r, cv::Size size) {
    const int x = static_cast<int>(std::floor(r.at("x").get<double>() * size.width));
    const int y = static_cast<int>(std::floor(r.at("y").get<double>() * size.height));
    const int right = static_cast<int>(std::ceil((r.at("x").get<double>() + r.at("width").get<double>()) * size.width));
    const int bottom = static_cast<int>(std::ceil((r.at("y").get<double>() + r.at("height").get<double>()) * size.height));
    if (x < 0 || y < 0 || right > size.width || bottom > size.height || right <= x || bottom <= y) throw std::runtime_error("答题区域越界");
    return {x, y, right - x, bottom - y};
}
cv::Mat rotated(const cv::Mat& image, int angle) {
    if (!angle) return image;
    cv::Mat result;
    cv::rotate(image, result, angle == 90 ? cv::ROTATE_90_CLOCKWISE : angle == 180 ? cv::ROTATE_180 : cv::ROTATE_90_COUNTERCLOCKWISE);
    return result;
}
// Solid square corner marks only. A missing mark is a review case, never a guessed paper corner.
bool corners(const cv::Mat& image, std::vector<cv::Point2f>& points) {
    cv::Mat bw;
    cv::threshold(image, bw, 100, 255, cv::THRESH_BINARY_INV);
    std::vector<std::vector<cv::Point>> contours;
    cv::findContours(bw, contours, cv::RETR_EXTERNAL, cv::CHAIN_APPROX_SIMPLE);
    points.clear();
    for (int quadrant = 0; quadrant < 4; ++quadrant) {
        double best = std::numeric_limits<double>::max();
        cv::Point2f found;
        for (const auto& contour : contours) {
            const auto r = cv::boundingRect(contour);
            const double cx = (r.x + r.width / 2.) / image.cols, cy = (r.y + r.height / 2.) / image.rows;
            const bool left = quadrant % 2 == 0, top = quadrant < 2;
            if ((left ? cx > .12 : cx < .88) || (top ? cy > .14 : cy < .86)) continue;
            const double ratio = static_cast<double>(r.width) / r.height;
            const double rel = static_cast<double>(r.area()) / image.total();
            if (ratio < .65 || ratio > 1.55 || rel < .000035 || rel > .0012 || cv::contourArea(contour) / r.area() < .72) continue;
            const double cost = std::abs(cx - (left ? .02 : .98)) + std::abs(cy - (top ? .045 : .95));
            if (cost < best) { best = cost; found = cv::Point2f(r.x + r.width / 2.f, r.y + r.height / 2.f); }
        }
        if (best == std::numeric_limits<double>::max()) return false;
        points.push_back(found);
    }
    return true;
}
// Verify printed landmarks, not answer ink. Missing/blurred print must not be interpreted as blank answers.
double matchQuality(const cv::Mat& scan, const cv::Mat& reference, const json& regions) {
    cv::Mat refInk, scanInk, expanded;
    cv::threshold(reference, refInk, 150, 255, cv::THRESH_BINARY_INV);
    cv::threshold(scan, scanInk, 175, 255, cv::THRESH_BINARY_INV);
    cv::dilate(scanInk, expanded, cv::getStructuringElement(cv::MORPH_RECT, {3, 3}));
    double total = 0, weights = 0, worst = 1;
    for (const auto& region : regions) {
        const auto r = rectangle(region, scan.size());
        cv::Mat intersection;
        cv::bitwise_and(refInk(r), expanded(r), intersection);
        const double printed = cv::countNonZero(refInk(r));
        if (printed < 30) continue;
        const double coverage = cv::countNonZero(intersection) / printed;
        // A saturated/very dark landmark is not evidence of a match.
        const double extra = cv::countNonZero(scanInk(r)) / std::max(1., printed);
        const double quality = coverage * std::min(1., 2.0 / std::max(1., extra));
        total += quality * std::sqrt(printed); weights += std::sqrt(printed); worst = std::min(worst, quality);
    }
    if (weights == 0) return 0;
    return .75 * (total / weights) + .25 * worst;
}
double fillRatio(const cv::Mat& scan, const cv::Mat& reference, const json& roi) {
    const auto r = rectangle(roi, scan.size());
    if (r.width < 12 || r.height < 10) throw std::runtime_error("填涂区域分辨率过低，请提高扫描清晰度");
    cv::Mat printed, excluded, added, darker;
    cv::threshold(reference(r), printed, 180, 255, cv::THRESH_BINARY_INV);
    cv::dilate(printed, excluded, cv::getStructuringElement(cv::MORPH_RECT, {3, 3}));
    cv::subtract(reference(r), scan(r), darker);
    cv::threshold(darker, added, 38, 255, cv::THRESH_BINARY);
    cv::Mat dark;
    cv::threshold(scan(r), dark, 200, 255, cv::THRESH_BINARY_INV);
    cv::bitwise_and(added, dark, added);
    cv::bitwise_and(added, ~excluded, added);
    return static_cast<double>(cv::countNonZero(added)) / std::max(1, r.area() - cv::countNonZero(excluded));
}
}

json recognize_external_paper(const std::filesystem::path& imagePath, const std::filesystem::path& layoutPath, const std::filesystem::path& output) {
    if (output.empty()) throw std::runtime_error("外部模板识别必须提供输出目录");
    const auto bytes = read_capped_file(layoutPath, recognizer_limits().max_layout_bytes, "external layout");
    const auto layout = json::parse(bytes.begin(), bytes.end());
    if (layout.at("version") != 1 || layout.at("pages").size() > 8 || layout.at("questions").size() > 200) throw std::runtime_error("不支持的外部模板");
    const cv::Mat original = gray(read_image(imagePath));
    if (original.cols < 900 || original.rows < 600) throw std::runtime_error("扫描页分辨率过低");
    cv::Mat small;
    const double downscale = std::min(1., 1800. / std::max(original.cols, original.rows));
    cv::resize(original, small, {}, downscale, downscale, cv::INTER_AREA);
    struct Candidate { double quality; int angle; int page; cv::Mat matrix; };
    std::vector<Candidate> candidates;
    std::vector<cv::Mat> references;
    for (const auto& page : layout.at("pages")) references.push_back(gray(read_image(page.at("referencePath").get<std::string>())));
    for (int angle : {0, 90, 180, 270}) {
        const auto scan = rotated(small, angle);
        std::vector<cv::Point2f> source;
        if (!corners(scan, source)) continue;
        for (size_t index = 0; index < references.size(); ++index) {
            cv::Mat reference;
            const auto& page = layout.at("pages").at(index);
            const double ratio = static_cast<double>(references[index].cols) / references[index].rows;
            if (std::abs(static_cast<double>(scan.cols) / scan.rows / ratio - 1) > .15) continue;
            cv::resize(references[index], reference, {1800, static_cast<int>(std::round(1800 / ratio))}, 0, 0, cv::INTER_AREA);
            std::vector<cv::Point2f> target;
            for (const auto& a : page.at("anchors")) target.emplace_back(a.at("x").get<float>() * reference.cols, a.at("y").get<float>() * reference.rows);
            if (target.size() != 4) throw std::runtime_error("模板需要四个定位点");
            const auto H = cv::getPerspectiveTransform(source, target);
            cv::Mat aligned;
            cv::warpPerspective(scan, aligned, H, reference.size(), cv::INTER_LINEAR, cv::BORDER_CONSTANT, 255);
            const double quality = matchQuality(aligned, reference, page.at("verificationRects"));
            // Translate the low-resolution transform back to the original and reference pixel grids.
            cv::Mat srcScale = (cv::Mat_<double>(3,3) << downscale,0,0,0,downscale,0,0,0,1);
            const double sx = static_cast<double>(references[index].cols) / reference.cols;
            const double sy = static_cast<double>(references[index].rows) / reference.rows;
            cv::Mat dstScale = (cv::Mat_<double>(3,3) << sx,0,0,0,sy,0,0,0,1);
            candidates.push_back({quality, angle, static_cast<int>(index), dstScale * H * srcScale});
        }
    }
    std::sort(candidates.begin(), candidates.end(), [](const auto& a, const auto& b) { return a.quality > b.quality; });
    const double best = candidates.empty() ? 0 : candidates[0].quality;
    const double margin = candidates.size() < 2 ? best : best - candidates[1].quality;
    if (best < .86 || margin < .075) return {{"status","failed"},{"message","页型或定位不确定，请核对完整扫描页后重扫"},{"quality",best},{"margin",margin},{"questions",json::array()},{"crops",json::array()}};
    const auto chosen = candidates.front();
    const int pageNumber = chosen.page + 1;
    const auto& reference = references[chosen.page];
    cv::Mat aligned, valid(original.size(), CV_8UC1, cv::Scalar(255)), validAligned;
    cv::warpPerspective(rotated(original, chosen.angle), aligned, chosen.matrix, reference.size(), cv::INTER_LINEAR, cv::BORDER_CONSTANT, 255);
    cv::warpPerspective(rotated(valid, chosen.angle), validAligned, chosen.matrix, reference.size(), cv::INTER_NEAREST, cv::BORDER_CONSTANT, 0);
    auto assertVisible = [&](const json& r) {
        const auto rect = rectangle(r, reference.size());
        if (cv::countNonZero(validAligned(rect)) < rect.area() * .999) throw std::runtime_error("作答区域有裁边，请重扫，不按空白题处理");
    };
    std::filesystem::create_directories(output);
    write_image(output / "aligned.png", aligned);
    json result = {{"status","ok"},{"pageNumber",pageNumber},{"rotation",chosen.angle},{"quality",best},{"margin",margin},{"questions",json::array()},{"crops",json::array()}};
    const auto& identity = layout.at("identity");
    if (identity.at("page") == pageNumber) {
        std::string digits;
        bool certain = true;
        for (int col = 1; col <= identity.at("digits").get<int>(); ++col) {
            std::string digit;
            bool ambiguous = false;
            for (const auto& cell : identity.at("cells")) {
                if (cell.at("column") != col) continue;
                assertVisible(cell.at("rect"));
                const double fill = fillRatio(aligned, reference, cell.at("rect"));
                if (fill > .28) { if (!digit.empty()) ambiguous = true; digit = cell.at("value").get<std::string>(); }
                else if (fill > .065) ambiguous = true;
            }
            if (digit.empty() || ambiguous) { certain = false; digits += "?"; } else digits += digit;
        }
        result["studentNumber"] = digits;
        result["identityCertain"] = certain;
    }
    for (const auto& question : layout.at("questions")) {
        const int number = question.at("number");
        if (question.at("type") == "objective") {
            if (question.at("options").at(0).at("page") != pageNumber) continue;
            json selected = json::array(), fills = json::array();
            bool ambiguous = false;
            for (const auto& option : question.at("options")) {
                assertVisible(option.at("rect"));
                const double fill = fillRatio(aligned, reference, option.at("rect"));
                fills.push_back(fill);
                if (fill > .28) selected.push_back(option.at("label"));
                else if (fill > .065) ambiguous = true;
            }
            if (selected.size() > question.at("requiredSelections").get<size_t>()) ambiguous = true;
            result["questions"].push_back({{"questionNumber",number},{"selectedOptions",selected},{"fillRatios",fills},{"status",ambiguous ? "review" : selected.empty() ? "blank" : "clear"}});
        } else {
            std::vector<cv::Mat> crops;
            int width = 0, height = 0;
            for (const auto& region : question.at("regions")) {
                if (region.at("page") != pageNumber) continue;
                assertVisible(region.at("rect"));
                const auto r = rectangle(region.at("rect"), aligned.size());
                crops.push_back(aligned(r)); width = std::max(width, r.width); height += r.height + 24;
            }
            if (crops.empty()) continue;
            assert_pixel_budget(static_cast<long long>(width) * height, "joined answer regions");
            cv::Mat joined(height, width, CV_8UC1, cv::Scalar(255));
            int top = 0;
            for (const auto& crop : crops) { crop.copyTo(joined(cv::Rect(0, top, crop.cols, crop.rows))); top += crop.rows + 24; }
            const auto path = output / ("q" + std::to_string(number) + ".png");
            write_image(path, joined);
            result["crops"].push_back({{"questionNumber",number},{"pageNumber",pageNumber},{"path",path.string()},{"width",width},{"height",height}});
        }
    }
    return result;
}
