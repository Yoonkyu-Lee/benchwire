// 예제 장면을 브라우저 작업대에 연다.
import "./style.css";
import { example, exampleLibrary } from "./example.ts";
import { mountWorkbench } from "./workbench.ts";

mountWorkbench(document.querySelector("#app")!, example, exampleLibrary, { title: "PoE 배선" });
