// display 추론 단계가 인용하는 규격 문서와 절을 등록한다.
export const DP_RATES = "dp-rates";
export const DP_VERSIONS = "dp-versions";
export const DP_ALT_MODE = "dp-alt-mode";
export const HDMI_FRL = "hdmi-frl";
export const HDMI_TMDS = "hdmi-tmds";
export const CVT_RB_V2 = "cvt-rb-v2";
export const CHROMA = "chroma";
export const DSC = "dsc";

export const sources = [
  { id: DP_RATES, title: "VESA DisplayPort Technology Update (2019), New DisplayPort Link Rates",
    locator: "https://vesa.org/wp-content/uploads/2019/11/VESA-DP-Tech-Update-2019-Workshop-Japan.pdf" },
  { id: DP_VERSIONS, title: "VESA DisplayPort Compliance, DP 2.1 Features and Specification Requirements",
    locator: "https://compliance.vesa.org/" },
  { id: DP_ALT_MODE, title: "VESA DisplayPort Alt Mode over USB Type-C (2019), pp. 21–23",
    locator: "https://www.usb.org/sites/default/files/D2T1-4%20-%20VESA%20DP%20Alt%20Mode%20over%20USB%20Type-C.pdf" },
  { id: HDMI_FRL, title: "HDMI FPGA IP User Guide, SCDC FRL rate 및 FRL Clocking Scheme",
    locator: "https://cdrdv2-public.intel.com/772809/ug_hdmi-683798-772809.pdf" },
  { id: HDMI_TMDS, title: "HDMI Specification 1.4b §3, §5.4 및 HDMI Forum의 HDMI 2.0 대역폭 발표",
    locator: "https://hdmiforum.org/hdmi-forum-releases-version-2-0-hdmi-specification/" },
  { id: CVT_RB_V2, title: "VESA Coordinated Video Timings 1.2 §3.4.3, §5.4 및 표 5-4",
    locator: "https://glenwing.github.io/docs/VESA-CVT-1.2.pdf" },
  { id: CHROMA, title: "ITU-T H.266 표 2 SubWidthC and SubHeightC",
    locator: "https://www.itu.int/rec/dologin_pub.asp?id=T-REC-H.266-202008-S%21%21PDF-E&lang=e&type=items" },
  { id: DSC, title: "VESA Display Stream Compression, DSC 압축률과 입력 형식",
    locator: "https://vesa.org/vesa-display-compression-codecs/dsc/" },
];
