function PageHeader({title,setPage,backPage}){


return (

<div className="mobile-header">


<button

className="header-back"

onClick={()=>setPage(backPage)}

>

←

</button>



<h1>

{title}

</h1>



</div>

)


}


export default PageHeader