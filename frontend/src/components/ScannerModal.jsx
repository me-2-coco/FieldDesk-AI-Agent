import { useEffect, useRef, useState } from "react"
import { Html5Qrcode } from "html5-qrcode"


function ScannerModal({
  open,
  mode = "logistics",
  title = "扫码",
  onScan,
  onClose
}) {

  const scannerRef = useRef(null)
  const onScanRef = useRef(onScan)
  const onCloseRef = useRef(onClose)
  const [cameraError, setCameraError] = useState("")

  useEffect(() => {
    onScanRef.current = onScan
    onCloseRef.current = onClose
  }, [onClose, onScan])


  useEffect(() => {

    if (!open) {
      return
    }

    let active = true

    const scanner = new Html5Qrcode("scanner-area")

    scannerRef.current = scanner


    scanner.start(
      {
        facingMode: "environment"
      },

      {
        fps: 10,

        qrbox: {
          width: 320,
          height: 320
        },

        aspectRatio: 1
      },


      async(decodedText)=>{

        try {

          await scanner.stop()

        } catch(e){

          console.log(e)

        }


        if (active) {
          onScanRef.current(decodedText)
          onCloseRef.current()
        }

      },


      ()=>{
        // 扫描失败不用处理
      }

    )
    .then(async () => {
      if (!active) await scanner.stop().catch(() => {})
    })
    .catch(()=>{
      if (active) {
        setCameraError(mode === "sn"
          ? "无法使用摄像头，请允许相机权限或手工输入 SN"
          : mode === "part"
            ? "无法使用摄像头，请允许相机权限或手工输入物料条码"
            : "无法使用摄像头，请允许相机权限或手工输入物流单号")
      }
    })

    function closeOnEscape(event) {
      if (event.key === "Escape") onCloseRef.current()
    }
    window.addEventListener("keydown", closeOnEscape)



    return ()=>{

      active = false
      window.removeEventListener("keydown", closeOnEscape)

      if(scannerRef.current){

        scannerRef.current
        .stop()
        .catch(()=>{})

      }

    }


  },[mode, open])



  if(!open){

    return null

  }



  return (

    <div className="scanner-mask">


      <div className="scanner-box">


        <div className="scanner-header">


          <span>
            {title}
          </span>



          <button
            type="button"
            className="scanner-close"
            aria-label="关闭扫码"
            onClick={onClose}
          >
            <span aria-hidden="true">✕</span>
            关闭扫码
          </button>


        </div>




        <div

          id="scanner-area"

          className="scanner-area"

        />




        <div className="scanner-footer">
          <div className="scanner-tip">
            {cameraError || (
              mode === "sn"
                ? "请将机器 SN 条码或二维码放入扫描框"
                : mode === "part"
                  ? "请将物料条码放入扫描框，识别后自动搜索"
                  : "请将物流条码放入扫描框"
            )}
          </div>
          <button type="button" className="scanner-footer-close" onClick={onClose}>关闭扫码</button>
        </div>



      </div>


    </div>

  )

}


export default ScannerModal
