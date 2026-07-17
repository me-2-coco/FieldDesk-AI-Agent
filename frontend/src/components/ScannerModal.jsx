import { useEffect, useRef } from "react"
import { Html5Qrcode } from "html5-qrcode"


function ScannerModal({
  open,
  title = "扫码",
  onScan,
  onClose
}) {

  const scannerRef = useRef(null)


  useEffect(() => {

    if (!open) {
      return
    }


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


        onScan(decodedText)

        onClose()

      },


      ()=>{
        // 扫描失败不用处理
      }

    )
    .catch(error=>{

      console.log(
        "摄像头启动失败:",
        error
      )

    })



    return ()=>{

      if(scannerRef.current){

        scannerRef.current
        .stop()
        .catch(()=>{})

      }

    }


  },[open])



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

            className="scanner-close"

            onClick={onClose}

          >

            ✕

          </button>


        </div>




        <div

          id="scanner-area"

          className="scanner-area"

        />




        <div className="scanner-tip">

          请将物流条码放入扫描框

        </div>



      </div>


    </div>

  )

}


export default ScannerModal